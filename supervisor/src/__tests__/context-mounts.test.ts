// ADR-157: read-only sibling-repo context mounts. Three supervisor-side
// surfaces are covered here:
//   1. the `contextMounts[]` acceptor (paired with the shape in
//      docs/api/supervisor.openapi.yaml — the acceptor must neither permit what
//      the spec forbids nor forbid what it permits);
//   2. the derived `MAISTER_CONTEXT_REPOS` child env var (D8b: JSON, omitted
//      entirely when the session has no mounts);
//   3. **L2** — the UNCONDITIONAL write-class deny over every declared mount
//      root, driven through the REAL `requestPermission` closure inside
//      `createAcpConnection` (an in-memory ACP pair, no child process).
//
// The L2 sessions below carry `autoApprovePermissions: true` and NO
// `hooksConfig` at all: an allowed call therefore resolves inline with the allow
// option, so a `cancelled` outcome can only come from the mount guard — proving
// both that the guard is not opt-in through `settings.hooks` and that it wins
// over B1 auto-approve.

import type { ContextMount, SessionRecord } from "../types";
import type { Logger } from "pino";

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAcpConnection, sendPromptOnConnection } from "../acp-client";
import {
  renderContextMountPreamble,
  takeContextMountPreamble,
} from "../context-mounts";
import { buildChildEnv } from "../spawn";
import { StartSessionRequestSchema } from "../types";

const BASE_SESSION = {
  runId: "run-1",
  projectSlug: "consumer",
  worktreePath: "/repos/consumer/.maister/worktrees/run-1",
  stepId: "plan",
  executor: { agent: "claude", model: "claude-sonnet-4-6" },
} as const;

const MOUNT: ContextMount = {
  slug: "api",
  path: "/repos/consumer/.maister/consumer/runs/run-1/context/api",
  ref: "main",
  commit: "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567",
};

const OPTIONS = [
  { optionId: "allow-1", kind: "allow_once", name: "Allow" },
  { optionId: "reject-1", kind: "reject_once", name: "Reject" },
];

describe("StartSessionRequestSchema contextMounts (ADR-157 acceptor)", () => {
  it("accepts a resolved mount payload", () => {
    const r = StartSessionRequestSchema.safeParse({
      ...BASE_SESSION,
      contextMounts: [MOUNT],
    });

    expect(r.success).toBe(true);
    expect(r.success && r.data.contextMounts).toEqual([MOUNT]);
  });

  it("stays valid without the field (existing senders unchanged)", () => {
    const r = StartSessionRequestSchema.safeParse(BASE_SESSION);

    expect(r.success).toBe(true);
    expect(r.success && r.data.contextMounts).toBeUndefined();
  });

  it("accepts the spec maximum of 8 mounts and rejects 9", () => {
    const mounts = Array.from({ length: 9 }, (_, i) => ({
      ...MOUNT,
      slug: `sib-${i}`,
      path: `${MOUNT.path}-${i}`,
    }));

    expect(
      StartSessionRequestSchema.safeParse({
        ...BASE_SESSION,
        contextMounts: mounts.slice(0, 8),
      }).success,
    ).toBe(true);
    expect(
      StartSessionRequestSchema.safeParse({
        ...BASE_SESSION,
        contextMounts: mounts,
      }).success,
    ).toBe(false);
  });

  it("rejects a relative path and a `..` segment (worktreePathSchema shape)", () => {
    for (const path of ["relative/context/api", "/repos/x/../../etc"]) {
      const r = StartSessionRequestSchema.safeParse({
        ...BASE_SESSION,
        contextMounts: [{ ...MOUNT, path }],
      });

      expect(r.success).toBe(false);
    }
  });

  it("rejects a non-kebab slug, a missing field, and an unknown field", () => {
    const bad: unknown[] = [
      { ...MOUNT, slug: "Not_Kebab" },
      { slug: MOUNT.slug, path: MOUNT.path, ref: MOUNT.ref },
      { ...MOUNT, extra: "nope" },
    ];

    for (const entry of bad) {
      expect(
        StartSessionRequestSchema.safeParse({
          ...BASE_SESSION,
          contextMounts: [entry],
        }).success,
      ).toBe(false);
    }
  });

  it("accepts an abbreviated sha and rejects a shorter one (spec bounds 7..64)", () => {
    expect(
      StartSessionRequestSchema.safeParse({
        ...BASE_SESSION,
        contextMounts: [{ ...MOUNT, commit: "0f1e2d3" }],
      }).success,
    ).toBe(true);
    expect(
      StartSessionRequestSchema.safeParse({
        ...BASE_SESSION,
        contextMounts: [{ ...MOUNT, commit: "0f1e2d" }],
      }).success,
    ).toBe(false);
  });
});

describe("buildChildEnv MAISTER_CONTEXT_REPOS (ADR-157 D8b)", () => {
  it("injects the JSON array parsed from the REAL request schema", () => {
    const parsed = StartSessionRequestSchema.parse({
      ...BASE_SESSION,
      contextMounts: [MOUNT],
    });
    const env = buildChildEnv(parsed);

    expect(JSON.parse(env.MAISTER_CONTEXT_REPOS ?? "null")).toEqual([MOUNT]);
  });

  it("omits the var entirely when there are no mounts (never an empty array)", () => {
    delete process.env.MAISTER_CONTEXT_REPOS;

    for (const contextMounts of [undefined, []]) {
      const env = buildChildEnv(
        StartSessionRequestSchema.parse({ ...BASE_SESSION, contextMounts }),
      );

      expect("MAISTER_CONTEXT_REPOS" in env).toBe(false);
    }
  });
});

describe("context-mount prompt preamble (ADR-157)", () => {
  it("names every mount's slug, absolute path, ref and read-only status", () => {
    const text = renderContextMountPreamble([
      MOUNT,
      { ...MOUNT, slug: "shared-types", ref: "v2.1.0" },
    ]);

    expect(text).toContain(`- api: ${MOUNT.path} (ref main) — READ-ONLY`);
    expect(text).toContain(
      `- shared-types: ${MOUNT.path} (ref v2.1.0) — READ-ONLY`,
    );
  });

  it("renders nothing without mounts", () => {
    expect(renderContextMountPreamble(undefined)).toBeNull();
    expect(renderContextMountPreamble([])).toBeNull();
  });

  it("is taken once per session (a resumed session rebuilds the record)", () => {
    const record = { contextMounts: [MOUNT] };

    expect(takeContextMountPreamble(record)).toContain("READ-ONLY");
    expect(takeContextMountPreamble(record)).toBeNull();
    // A respawn rebuilds SessionRecord from the request → grounded again.
    expect(takeContextMountPreamble({ contextMounts: [MOUNT] })).toContain(
      "READ-ONLY",
    );
  });

  it("prepends its own block and forwards the caller's blocks verbatim", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const contentBlocks = [
      { type: "text", text: "do the thing" },
      { type: "resource_link", uri: "file:///w/n.txt", name: "n.txt" },
    ] as unknown as acp.ContentBlock[];

    await sendPromptOnConnection(
      { prompt } as unknown as acp.ClientSideConnection,
      {
        adapter: "claude",
        acpSessionId: "s1",
        stepId: "plan",
        prompt: "do the thing",
        contentBlocks,
        preamble: "MOUNTS",
      },
      { info: vi.fn(), warn: vi.fn() } as unknown as Logger,
    );

    expect(prompt).toHaveBeenCalledWith({
      sessionId: "s1",
      prompt: [{ type: "text", text: "MOUNTS" }, ...contentBlocks],
    });
  });

  it("leaves a mount-less prompt byte-identical", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });

    await sendPromptOnConnection(
      { prompt } as unknown as acp.ClientSideConnection,
      {
        adapter: "claude",
        acpSessionId: "s1",
        stepId: "plan",
        prompt: "hello",
      },
      { info: vi.fn(), warn: vi.fn() } as unknown as Logger,
    );

    expect(prompt).toHaveBeenCalledWith({
      sessionId: "s1",
      prompt: [{ type: "text", text: "hello" }],
    });
  });
});

type Harness = {
  ask: (toolCall: unknown) => Promise<acp.RequestPermissionResponse>;
  record: SessionRecord;
  warn: ReturnType<typeof vi.fn>;
  close: () => void;
};

const openHarnesses: Harness[] = [];

// Drive the production requestPermission closure over an in-memory ACP pair:
// the test plays the AGENT side (answering the handshake, then calling
// session/request_permission), the supervisor plays its real client side.
async function openSession(opts: {
  worktreePath: string;
  contextMounts?: ContextMount[];
}): Promise<Harness> {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  const warn = vi.fn();
  const logger = {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  let agentConn: acp.AgentSideConnection | undefined;
  const agentImpl: acp.Agent = {
    async initialize() {
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
    },
    async newSession() {
      return { sessionId: "acp-session-1" };
    },
    async authenticate() {
      return {};
    },
    async prompt() {
      return { stopReason: "end_turn" as const };
    },
    async cancel() {
      /* no-op */
    },
  };

  agentConn = new acp.AgentSideConnection(
    () => agentImpl,
    acp.ndJsonStream(
      Writable.toWeb(agentToClient) as never,
      Readable.toWeb(clientToAgent) as never,
    ),
  );

  const record = {
    sessionId: "sess-1",
    adapter: "claude",
    runId: BASE_SESSION.runId,
    projectSlug: BASE_SESSION.projectSlug,
    stepId: BASE_SESSION.stepId,
    sessionName: "default",
    status: "live",
    pid: 1,
    startedAt: new Date().toISOString(),
    logPath: join(opts.worktreePath, "plan.log"),
    worktreePath: opts.worktreePath,
    monotonicId: 0,
    // No hooksConfig, no enforcementProfile: the mount guard must be armed by
    // the mounts alone. Auto-approve makes every non-denied call resolve inline.
    autoApprovePermissions: true,
    contextMounts: opts.contextMounts,
  } as SessionRecord;

  await createAcpConnection({
    stdin: clientToAgent,
    stdoutSource: agentToClient,
    sessionId: record.sessionId,
    worktreePath: opts.worktreePath,
    record,
    emitter: new EventEmitter(),
    logger,
    adapter: "claude",
  });

  const harness: Harness = {
    ask: (toolCall) =>
      (agentConn as acp.AgentSideConnection).requestPermission({
        sessionId: "acp-session-1",
        toolCall: toolCall as never,
        options: OPTIONS as never,
      }),
    record,
    warn,
    close: () => {
      clientToAgent.end();
      agentToClient.end();
    },
  };

  openHarnesses.push(harness);

  return harness;
}

function writeCall(path: string) {
  return { toolCallId: "tc-1", kind: "edit", locations: [{ path }] };
}

function readCall(path: string) {
  return { toolCallId: "tc-2", kind: "read", locations: [{ path }] };
}

afterEach(() => {
  for (const h of openHarnesses.splice(0)) h.close();
});

describe("L2 — unconditional read-only guard over context mounts", () => {
  it("denies a write-class tool call inside a mount and WARNs with slug + path", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-mount-"));
    const mountPath = join(root, "context", "api");

    await mkdir(mountPath, { recursive: true });

    const h = await openSession({
      worktreePath: root,
      contextMounts: [{ ...MOUNT, path: mountPath }],
    });
    const target = join(mountPath, "src", "contract.ts");

    const res = await h.ask(writeCall(target));

    expect(res.outcome).toEqual({ outcome: "cancelled" });
    expect(
      h.warn.mock.calls.some(
        ([obj]) =>
          (obj as { mountSlug?: string; path?: string }).mountSlug === "api" &&
          (obj as { path?: string }).path === target,
      ),
    ).toBe(true);
  });

  it("ALLOWS a read of the same mount (read-only, not a blanket deny)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-mount-"));
    const mountPath = join(root, "context", "api");

    await mkdir(mountPath, { recursive: true });
    await writeFile(join(mountPath, "contract.ts"), "export {};\n");

    const h = await openSession({
      worktreePath: root,
      contextMounts: [{ ...MOUNT, path: mountPath }],
    });

    const res = await h.ask(readCall(join(mountPath, "contract.ts")));

    expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("leaves a write OUTSIDE every mount unaffected", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-mount-"));
    const mountPath = join(root, "context", "api");

    await mkdir(mountPath, { recursive: true });

    const h = await openSession({
      worktreePath: root,
      contextMounts: [{ ...MOUNT, path: mountPath }],
    });

    // Own worktree file, plus a sibling directory sharing the mount's PREFIX —
    // a string-prefix guard would false-positive on the latter.
    for (const target of [
      join(root, "src", "app.ts"),
      join(root, "context", "api-notes", "scratch.md"),
    ]) {
      const res = await h.ask(writeCall(target));

      expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
    }
  });

  it("is inert for a session with no mounts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-mount-"));
    const h = await openSession({ worktreePath: root });

    const res = await h.ask(writeCall(join(root, "anything.ts")));

    expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("denies a move whose DESTINATION is in a mount (every reported location)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-mount-"));
    const mountPath = join(root, "context", "api");

    await mkdir(mountPath, { recursive: true });

    const h = await openSession({
      worktreePath: root,
      contextMounts: [{ ...MOUNT, path: mountPath }],
    });

    const res = await h.ask({
      toolCallId: "tc-3",
      kind: "move",
      locations: [
        { path: join(root, "src", "app.ts") },
        { path: join(mountPath, "app.ts") },
      ],
    });

    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });

  it("WARNs once when the adapter reports no path for a write (cannot verify)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-mount-"));
    const h = await openSession({
      worktreePath: root,
      contextMounts: [{ ...MOUNT, path: join(root, "context", "api") }],
    });

    // Kind-only adapters (gemini/opencode/mimo) omit locations. Denying here
    // would block the session's own worktree writes, so the call passes and L3
    // backstops — but the operator is told, once.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await h.ask({ toolCallId: "tc-4", kind: "edit" });

      expect(res.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
    }

    expect(
      h.warn.mock.calls.filter(([, msg]) =>
        String(msg).includes("[context-mount] adapter omits"),
      ),
    ).toHaveLength(1);
  });

  it("denies a write that reaches a mount through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-mount-"));
    const mountPath = join(root, "context", "api");

    await mkdir(mountPath, { recursive: true });
    await mkdir(join(root, "work"), { recursive: true });
    await symlink(mountPath, join(root, "work", "sibling"));

    const h = await openSession({
      worktreePath: root,
      contextMounts: [{ ...MOUNT, path: mountPath }],
    });

    const res = await h.ask(
      writeCall(join(root, "work", "sibling", "contract.ts")),
    );

    expect(res.outcome).toEqual({ outcome: "cancelled" });
  });
});
