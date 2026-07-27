import "server-only";

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { atomicWriteText } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";
import { agentMemoryMaxChars } from "@/lib/instance-config";
import { runtimeRoot } from "@/lib/runtime-root";

const log = pino({
  name: "agent-memory-store",
  level: process.env.LOG_LEVEL ?? "info",
});

const MEMORY_FILE = "memory.md";
const SAFE_COMPONENT_BYTE = /^[A-Za-z0-9._-]$/;

// ADR-152 D10. Keeps `[A-Za-z0-9._-]` verbatim and rewrites every other BYTE as
// `%XX` uppercase. Because an encoded component can never itself contain `/` or
// `:`, the (packageName, stem) -> path map is INJECTIVE — two distinct ids
// cannot land on one file. That is strictly stronger than the
// collision-RESISTANCE a truncated-hash suffix would buy. Encoding bytes rather
// than code points keeps the map total over non-ASCII ids.
function enc(component: string): string {
  let out = "";

  for (const byte of Buffer.from(component, "utf8")) {
    const char = String.fromCharCode(byte);

    out += SAFE_COMPONENT_BYTE.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  return out;
}

// `.` and `..` survive the encoder verbatim (both are made of safe bytes) and
// would resolve to the current/parent directory, so they are refused rather
// than encoded — the one case where a safe-looking component is not safe.
function assertUsableComponent(component: string, agentId: string): string {
  const encoded = enc(component);

  if (encoded.length === 0 || encoded === "." || encoded === "..") {
    throw new MaisterError(
      "CONFIG",
      `agent memory: agent "${agentId}" has an unusable path component "${component}"`,
    );
  }

  return encoded;
}

export function agentMemoryPath(projectSlug: string, agentId: string): string {
  const separator = agentId.indexOf(":");

  // A bare stem must NOT fall back to a single level: two agents from different
  // packages share a stem, so the fallback would silently merge their memories.
  if (separator <= 0) {
    throw new MaisterError(
      "CONFIG",
      `agent memory: "${agentId}" is not a qualified <packageName>:<stem> id`,
    );
  }

  const packageName = assertUsableComponent(
    agentId.slice(0, separator),
    agentId,
  );
  const stem = assertUsableComponent(agentId.slice(separator + 1), agentId);

  return path.join(
    runtimeRoot(),
    ".maister",
    projectSlug,
    "agents",
    packageName,
    stem,
    MEMORY_FILE,
  );
}

export function hashAgentMemory(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type AgentMemoryState = {
  content: string;
  hash: string | null;
  sizeChars: number;
  updatedAt: Date | null;
};

// The file's ACTUAL state, with NO cap gate. The CAS compares against this: an
// over-cap file still has a real hash, and comparing against the degraded
// `null` would let a first-writer `ifHash: null` silently clobber it.
export async function readAgentMemoryRaw(
  projectSlug: string,
  agentId: string,
): Promise<AgentMemoryState> {
  const filePath = agentMemoryPath(projectSlug, agentId);

  try {
    const stats = await stat(filePath);

    if (!stats.isFile()) {
      log.warn(
        { agentId, projectSlug, reason: "unreadable" },
        "[agents.memory] memory path is not a regular file",
      );

      return { content: "", hash: null, sizeChars: 0, updatedAt: null };
    }

    const content = await readFile(filePath, "utf8");

    return {
      content,
      hash: hashAgentMemory(content),
      sizeChars: content.length,
      updatedAt: stats.mtime,
    };
  } catch (err) {
    const code = (err as { code?: string }).code;

    if (code !== "ENOENT" && code !== "ENOTDIR") {
      log.warn(
        { agentId, code, projectSlug, reason: "unreadable" },
        "[agents.memory] memory file could not be read",
      );
    }

    return { content: "", hash: null, sizeChars: 0, updatedAt: null };
  }
}

// ADR-152 REQ-C7 / D18: the ONE content-hash CAS, shared by the agent ext route
// and the owner PUT — a blind human Save must not clobber a concurrent agent
// write, so the human clears the same bar. Ordering is read-current -> compare
// -> atomic write -> return the POST-write hash.
export async function writeAgentMemoryCas(
  projectSlug: string,
  agentId: string,
  content: string,
  ifHash: string | null,
): Promise<
  { ok: true; hash: string } | { ok: false; current: AgentMemoryState }
> {
  const current = await readAgentMemoryRaw(projectSlug, agentId);

  if ((current.hash ?? null) !== (ifHash ?? null)) {
    log.info(
      { agentId, projectSlug, priorHash: current.hash, ifHash },
      "[agents.memory] CAS lost",
    );

    return { ok: false, current };
  }

  const { hash } = await writeAgentMemory(projectSlug, agentId, content);

  return { ok: true, hash };
}

// The LAUNCH view: the raw state plus the cap gate. Absent, unreadable, and
// over-cap all collapse to `null` so a launch can never be blocked by memory.
export async function readAgentMemory(
  projectSlug: string,
  agentId: string,
): Promise<{ content: string; hash: string; sizeChars: number } | null> {
  const raw = await readAgentMemoryRaw(projectSlug, agentId);

  if (raw.hash === null) return null;

  const max = agentMemoryMaxChars();

  if (raw.sizeChars > max) {
    log.warn(
      {
        agentId,
        max,
        projectSlug,
        reason: "over_cap",
        sizeChars: raw.sizeChars,
      },
      "[agents.memory] memory file exceeds the cap — degrading to no memory",
    );

    return null;
  }

  log.debug(
    { agentId, hash: raw.hash, projectSlug, sizeChars: raw.sizeChars },
    "[agents.memory] read",
  );

  return { content: raw.content, hash: raw.hash, sizeChars: raw.sizeChars };
}

export async function writeAgentMemory(
  projectSlug: string,
  agentId: string,
  content: string,
): Promise<{ hash: string }> {
  const max = agentMemoryMaxChars();

  if (content.length > max) {
    throw new MaisterError(
      "CONFIG",
      `agent memory: content is ${content.length} characters, over the ${max}-character cap`,
    );
  }

  const filePath = agentMemoryPath(projectSlug, agentId);

  await atomicWriteText(filePath, content);

  const hash = hashAgentMemory(content);

  log.debug(
    { agentId, hash, projectSlug, sizeChars: content.length },
    "[agents.memory] written",
  );

  return { hash };
}
