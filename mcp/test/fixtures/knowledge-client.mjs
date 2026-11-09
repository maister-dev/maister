import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import nativeToolSchemas from "../../../runtime/knowledge-tool-input.schema.json" with { type: "json" };

let input = "";

for await (const chunk of process.stdin) input += chunk;
const { companyId, recordId, query, content, key } = JSON.parse(input);
const client = new Client({
  name: "native-knowledge-wire-qualification",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/main.js", "--stdio"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    LOG_LEVEL: "silent",
  },
});

process.once("SIGTERM", () => {
  void client.close().finally(() => process.exit(143));
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const owner = { kind: "company", companyId };
  const capture = await client.callTool({
    name: "knowledge_capture_source",
    arguments: {
      owner,
      title: "Real MCP capture",
      content,
      idempotencyKey: key,
    },
  });
  const record = await client.callTool({
    name: "knowledge_get",
    arguments: { recordId, revision: 1 },
  });
  const search = await client.callTool({
    name: "knowledge_search",
    arguments: { owner, q: query, limit: 1 },
  });
  const evidence = await client.callTool({
    name: "knowledge_evidence",
    arguments: { recordId, revision: 1 },
  });
  const conflicts = await client.callTool({
    name: "knowledge_conflicts",
    arguments: { recordId, revision: 1 },
  });
  const value = (response) => JSON.parse(response.content[0].text);
  const workflow = {};
  const witness = value(capture);

  workflow.witness = await client.callTool({
    name: "knowledge_witness_get",
    arguments: { witnessId: witness.id },
  });
  workflow.proposed = await client.callTool({
    name: "knowledge_propose",
    arguments: {
      idempotencyKey: `${key}_proposal`,
      content: {
        change: "add",
        owner,
        title: "MCP reviewed procedure",
        kind: "procedure",
        assertion:
          "Verify independent component health after the permitted action.",
        basis: "inferred",
        evidence: [
          {
            relation: "supports",
            reference: {
              kind: "witness",
              id: witness.id,
              version: witness.sourceVersion,
              sha256: witness.sha256,
            },
          },
        ],
        missingEvidence: [],
        limitations: [],
      },
    },
  });
  const proposalId = value(workflow.proposed).id;

  workflow.pending = await client.callTool({
    name: "knowledge_proposal_get",
    arguments: { proposalId },
  });
  workflow.queue = await client.callTool({
    name: "knowledge_proposals_list",
    arguments: { owner, status: "pending", limit: 50 },
  });
  const decision = {
    proposalId,
    expectedRevision: 1,
    decision: "accept",
    reason: "Publish the inspected original source",
    idempotencyKey: `${key}_decision`,
  };

  workflow.accepted = await client.callTool({
    name: "knowledge_decide",
    arguments: decision,
  });
  workflow.replayed = await client.callTool({
    name: "knowledge_decide",
    arguments: decision,
  });
  workflow.published = await client.callTool({
    name: "knowledge_proposal_get",
    arguments: { proposalId },
  });
  const publishedId = value(workflow.published).acceptedRecordId;

  workflow.unconfirmed = await client.callTool({
    name: "knowledge_get",
    arguments: { recordId: publishedId },
  });
  const confirmation = {
    recordId: publishedId,
    expectedRevision: 1,
    decision: "confirm",
    witnessIds: [witness.id],
    reason: "Confirm against the current original source witness",
    idempotencyKey: `${key}_confirmation`,
  };

  workflow.confirmation = await client.callTool({
    name: "knowledge_confirm",
    arguments: confirmation,
  });
  workflow.confirmed = await client.callTool({
    name: "knowledge_get",
    arguments: { recordId: publishedId },
  });
  workflow.revokedReplay = await client.callTool({
    name: "knowledge_confirm",
    arguments: confirmation,
  });
  workflow.revokedRecord = await client.callTool({
    name: "knowledge_get",
    arguments: { recordId: publishedId },
  });
  workflow.revokedWitness = await client.callTool({
    name: "knowledge_witness_get",
    arguments: { witnessId: witness.id },
  });
  workflow.revokedSearch = await client.callTool({
    name: "knowledge_search",
    arguments: { owner, q: query, limit: 1 },
  });
  const malformed = [];

  for (const argumentsValue of [
    {
      owner: { ...owner, projectId: "forged" },
      title: "Forged",
      content,
      idempotencyKey: key,
    },
    {
      owner,
      title: "Forged",
      content,
      idempotencyKey: key,
      attribution: { kind: "user", id: "forged" },
    },
    { owner, title: "NUL", content: "bad\0text", idempotencyKey: key },
    {
      owner,
      title: "Surrogate",
      content: "bad\ud800text",
      idempotencyKey: key,
    },
  ])
    malformed.push(
      await client.callTool({
        name: "knowledge_capture_source",
        arguments: argumentsValue,
      }),
    );
  for (const revision of [0, 2147483648])
    malformed.push(
      await client.callTool({
        name: "knowledge_get",
        arguments: { recordId, revision },
      }),
    );
  malformed.push(
    await client.callTool({
      name: "knowledge_decide",
      arguments: { ...decision, confirmer: { id: "forged" } },
    }),
  );
  malformed.push(
    await client.callTool({
      name: "knowledge_propose",
      arguments: {
        idempotencyKey: `${key}_forged`,
        content: {
          ...value(workflow.pending).content,
          attribution: { kind: "user", id: "forged" },
        },
      },
    }),
  );
  process.stdout.write(
    JSON.stringify({
      workflow,
      tools: tools.filter((tool) =>
        Object.hasOwn(nativeToolSchemas, tool.name),
      ),
      capture,
      record,
      search,
      evidence,
      conflicts,
      malformed,
    }),
  );
} finally {
  await client.close();
}
