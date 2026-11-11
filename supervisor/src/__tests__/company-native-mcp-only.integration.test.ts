import type { SessionEvent } from "../types";
import type { CompanyFlowKnowledgeScope } from "../../../runtime/company-flow-tools";

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { companyFlowEnforcementProfile } from "../../../runtime/company-flow-tools";
import { pendingPermissions } from "../pending-permissions";

import {
  bootHost,
  cleanupRuntimeRoot,
  completePrompt,
  createBody,
  envelope,
  fenceFor,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

let host: BootedHost | null = null;
const runId = "company-native-node";

async function runCompanyScenario(
  scenario: string,
  scopes: readonly CompanyFlowKnowledgeScope[],
  reviewedActions: readonly string[] = scopes,
): Promise<SessionEvent[]> {
  host = await bootHost({
    fixture: "mock-acp-guardrail.mjs",
    fixtureArgs: ["--scenario", scenario],
  });
  const companyPath = join(
    host.runtimeRoot,
    ".company",
    createHash("sha256")
      .update(JSON.stringify(["company-native", runId]))
      .digest("hex"),
  );

  await mkdir(companyPath, { recursive: true });
  const adopted = await postJson(
    `${host.url}/workspaces/adopt`,
    envelope("workspace.adopt", fenceFor(host, runId), {
      runId,
      projectSlug: "_company",
      owner: { kind: "company", companyId: "company-native" },
      kind: "directory",
      path: companyPath,
    }),
  );

  expect(adopted.status).toBe(200);
  const handle = (adopted.body as { executionWorkspaceId: string })
    .executionWorkspaceId;
  const created = await postJson(
    `${host.url}/sessions`,
    envelope(
      "session.create",
      fenceFor(host, runId),
      createBody(handle, {
        autoApprovePermissions: true,
        readOnlySession: false,
        enforcementProfile: companyFlowEnforcementProfile(
          scopes,
          reviewedActions,
        ),
      }),
    ),
  );

  expect(created.status).toBe(201);
  const sessionId = (created.body as { sessionId: string }).sessionId;
  const completed = await completePrompt(
    host,
    sessionId,
    envelope("session.prompt", fenceFor(host, runId), {
      stepId: "diagnose",
      prompt: "Inspect only scoped company evidence",
    }),
  );

  expect(completed.status).toBe(200);
  expect(pendingPermissions.size(sessionId)).toBe(0);

  return host.registry.snapshotEvents(sessionId);
}

function trips(events: SessionEvent[]) {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: "session.hook_trip" }> =>
      event.type === "session.hook_trip",
  );
}

afterEach(async () => {
  if (!host) return;
  await host.stop();
  await cleanupRuntimeRoot(host.runtimeRoot);
  host = null;
});

describe("company native MCP-only enforcement", () => {
  it.each([
    { acceptance: [], expectedDenials: 1 },
    { acceptance: ["assignments:accept"], expectedDenials: 0 },
  ] as const)(
    "requires the reviewed acceptance scope for a work decision ($expectedDenials denials)",
    async ({ acceptance, expectedDenials }) => {
      const events = await runCompanyScenario("company_native_acceptance", [
        "knowledge:read",
        "assignments:read",
        "assignments:update",
        ...acceptance,
      ]);

      expect(trips(events)).toHaveLength(expectedDenials);
    },
  );
  it.each([
    {
      scenario: "company_native_delegation",
      extraActions: ["assignments:delegate"],
      expectedDenials: 0,
    },
    {
      scenario: "company_native_delegation",
      extraActions: [],
      expectedDenials: 2,
    },
    {
      scenario: "company_native_rework",
      extraActions: ["assignments:delegate"],
      expectedDenials: 0,
    },
    { scenario: "company_native_rework", extraActions: [], expectedDenials: 1 },
  ])(
    "requires a reviewed delegation action for $scenario ($expectedDenials denials)",
    async ({ scenario, extraActions, expectedDenials }) => {
      const scopes = [
        "knowledge:read",
        "assignments:read",
        "assignments:update",
      ] as const;
      const events = await runCompanyScenario(scenario, scopes, [
        ...scopes,
        ...extraActions,
      ]);

      expect(trips(events)).toHaveLength(expectedDenials);
    },
  );
  it("admits exact knowledge tools while denying file, shell, confirmation and private memory despite auto approval", async () => {
    const events = await runCompanyScenario("company_native_mcp_only", [
      "knowledge:read",
      "knowledge:propose",
    ]);

    expect(trips(events)).toHaveLength(4);
    expect(
      trips(events).every(
        (event) =>
          event.rule === "capability_guard" && event.disposition === "deny",
      ),
    ).toBe(true);
  });
  it("a read-only credential does not admit proposal tools", async () => {
    const events = await runCompanyScenario("company_native_read_scope", [
      "knowledge:read",
    ]);

    expect(trips(events)).toHaveLength(1);
    expect(trips(events)[0]).toMatchObject({
      rule: "capability_guard",
      disposition: "deny",
    });
  });
  it("a tool-less company role cannot evade the existing denial breaker", async () => {
    const events = await runCompanyScenario("librarian_builtin_repeat", []);

    expect(
      trips(events).filter((event) => event.disposition === "halt"),
    ).toHaveLength(1);
    expect(
      trips(events).filter((event) => event.disposition === "deny"),
    ).toHaveLength(2);
  });
});
