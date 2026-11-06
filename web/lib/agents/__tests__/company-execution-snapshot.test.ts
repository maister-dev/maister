import { describe, expect, it } from "vitest";

import { companyAgentExecutionSnapshotSchema } from "../company-agent-execution-types";
import { companyExecutionSnapshotSchema } from "../company-execution-types";

const owner = { kind: "company", companyId: "company-real" };
const configuration = {
  id: "binding-real",
  revision: 2,
  snapshotSha256: "a".repeat(64),
};
const standalone = {
  schemaVersion: 1,
  owner,
  assignmentRevision: 3,
  assignment: {
    id: "assignment-real",
    inputRevision: 2,
    inputSha256: "b".repeat(64),
  },
  specialistBinding: configuration,
  authority: {
    actor: { kind: "user", id: "user-real", runId: null, attemptId: null },
    witness: {
      kind: "company_grant",
      owner,
      authorityId: "grant-real",
      revision: 4,
      action: "assignments:update",
    },
  },
};
const graph = {
  ...standalone,
  schemaVersion: 2,
  executionKind: "flow",
  coordinatorFlowBinding: { ...configuration, id: "coordinator-real" },
};

describe("versioned company execution capture", () => {
  it("reads both exact versions without defaulting or rewriting historical standalone bytes", () => {
    expect(companyExecutionSnapshotSchema.parse(standalone)).toEqual(
      standalone,
    );
    expect(companyExecutionSnapshotSchema.parse(graph)).toEqual(graph);
    expect(companyAgentExecutionSnapshotSchema.parse(standalone)).toEqual(
      standalone,
    );
    expect(companyAgentExecutionSnapshotSchema.safeParse(graph).success).toBe(
      false,
    );
  });

  it.each([
    { ...graph, schemaVersion: 3 },
    { ...graph, executionKind: "agent" },
    { ...graph, coordinatorFlowBinding: undefined },
    { ...graph, coordinatorFlowBinding: { ...configuration, revision: 0 } },
    {
      ...graph,
      coordinatorFlowBinding: { ...configuration, revision: 2147483648 },
    },
    { ...graph, coordinatorFlowBinding: { ...configuration, revision: 1.5 } },
    {
      ...graph,
      coordinatorFlowBinding: {
        ...configuration,
        snapshotSha256: "unwitnessed",
      },
    },
    { ...graph, owner: { kind: "project", projectId: "fabricated" } },
    {
      ...graph,
      authority: {
        ...graph.authority,
        witness: {
          ...graph.authority.witness,
          owner: { ...owner, companyId: "foreign-company" },
        },
      },
    },
    {
      ...graph,
      authority: {
        ...graph.authority,
        actor: { ...graph.authority.actor, kind: "agent" },
      },
    },
    {
      ...graph,
      authority: {
        ...graph.authority,
        witness: { ...graph.authority.witness, action: "assignments:accept" },
      },
    },
    { ...graph, projectId: "fabricated" },
    { ...standalone, coordinatorFlowBinding: configuration },
  ])(
    "refuses forged, malformed or version-confused launch identity: %j",
    (value) => {
      expect(companyExecutionSnapshotSchema.safeParse(value).success).toBe(
        false,
      );
    },
  );
});
