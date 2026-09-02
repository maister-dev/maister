import { describe, expect, it } from "vitest";

import {
  buildAgentProfileContract,
  buildFlowExportContract,
  isResultProducerNode,
  schemaRefFor,
  schemaStemFromPath,
} from "@/lib/run-results/contract";

// ADR-165 AC-10 / spec C-1.3. `schemaRef` is derived from server state alone —
// it is the string a coordinator sees beside every result, and the only place
// the pinned revision surfaces to it.

const SCHEMA = { schemaVersion: 2, fields: [] };

describe("schemaRefFor", () => {
  it("is <flowRefId>@<rev12>:<stem>", () => {
    expect(
      schemaRefFor({
        flowRefId: "core-rah",
        resolvedRevision: "1a2b3c4d5e6f7890",
        schemaStem: "research-result.v1",
      }),
    ).toBe("core-rah@1a2b3c4d5e6f:research-result.v1");
  });

  it("truncates the revision to 12 characters, never pads a shorter one", () => {
    expect(
      schemaRefFor({
        flowRefId: "p",
        resolvedRevision: "abc",
        schemaStem: "s",
      }),
    ).toBe("p@abc:s");
  });
});

describe("schemaStemFromPath", () => {
  it.each([
    ["./schemas/research-result.v1.json", "research-result.v1"],
    ["schemas/research-result.v1.json", "research-result.v1"],
    ["  ./schemas/plain.json  ", "plain"],
  ])("%s -> %s", (path, stem) => {
    expect(schemaStemFromPath(path)).toBe(stem);
  });
});

describe("buildFlowExportContract", () => {
  it("snapshots the schema, its identity and the producer set", () => {
    const contract = buildFlowExportContract({
      flowRefId: "core-rah",
      resolvedRevision: "1a2b3c4d5e6f7890",
      flowRevisionId: "rev-uuid",
      schemaPath: "./schemas/research-result.v1.json",
      schema: SCHEMA,
      sha256: "f".repeat(64),
      required: true,
      producerNodeIds: ["orchestrate"],
    });

    expect(contract).toEqual({
      kind: "flow_export",
      schemaRef: "core-rah@1a2b3c4d5e6f:research-result.v1",
      // Read from the DOCUMENT, never from the declaration.
      schemaVersion: 2,
      sha256: "f".repeat(64),
      required: true,
      producerNodeIds: ["orchestrate"],
      schema: SCHEMA,
      flowRevisionId: "rev-uuid",
    });
  });

  it("copies producerNodeIds rather than aliasing the caller's array", () => {
    const producers = ["orchestrate"];
    const contract = buildFlowExportContract({
      flowRefId: "p",
      resolvedRevision: "r",
      flowRevisionId: "rev",
      schemaPath: "./schemas/x.json",
      schema: SCHEMA,
      sha256: "a",
      required: true,
      producerNodeIds: producers,
    });

    producers.push("mutated");
    expect(
      contract.kind === "flow_export" ? contract.producerNodeIds : [],
    ).toEqual(["orchestrate"]);
  });
});

describe("buildAgentProfileContract", () => {
  it("is always required and records WHICH pinned revision resolved it", () => {
    const contract = buildAgentProfileContract({
      profileName: "research",
      flowRefId: "core-rah",
      resolvedRevision: "1a2b3c4d5e6f7890",
      sourceFlowRevisionId: "rev-uuid",
      schemaStem: "research-result.v1",
      schemaVersion: 2,
      schema: SCHEMA,
      sha256: "b".repeat(64),
    });

    expect(contract).toEqual({
      kind: "agent_profile",
      profileName: "research",
      schemaRef: "core-rah@1a2b3c4d5e6f:research-result.v1",
      schemaVersion: 2,
      sha256: "b".repeat(64),
      required: true,
      schema: SCHEMA,
      sourceFlowRevisionId: "rev-uuid",
    });
  });
});

describe("isResultProducerNode", () => {
  const flowContract = buildFlowExportContract({
    flowRefId: "p",
    resolvedRevision: "r",
    flowRevisionId: "rev",
    schemaPath: "./schemas/x.json",
    schema: SCHEMA,
    sha256: "a",
    required: true,
    producerNodeIds: ["orchestrate", "reduce"],
  });

  it.each([
    ["orchestrate", true],
    ["reduce", true],
    ["writer", false],
  ] as const)("%s -> %s", (nodeId, expected) => {
    expect(isResultProducerNode(flowContract, nodeId)).toBe(expected);
  });

  it("is false for a NULL contract and for an agent-profile contract", () => {
    expect(isResultProducerNode(null, "orchestrate")).toBe(false);
    expect(
      isResultProducerNode(
        buildAgentProfileContract({
          profileName: "research",
          flowRefId: "p",
          resolvedRevision: "r",
          sourceFlowRevisionId: "rev",
          schemaStem: "x",
          schemaVersion: 1,
          schema: SCHEMA,
          sha256: "a",
        }),
        "orchestrate",
      ),
    ).toBe(false);
  });
});
