import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const proposalId = process.env.MAISTER_TEST_PROPOSAL_ID;
const recordId = process.env.MAISTER_TEST_RECORD_ID;
const profile = process.env.MAISTER_MCP_TOOLSET ?? "";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/main.js", "--stdio"],
  env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "silent" },
});
const client = new Client({
  name: "personal-knowledge-qualification",
  version: "1.0.0",
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  if (recordId) {
    const result = await client.callTool({
      name: "knowledge_revisions_list",
      arguments: { recordId },
    });

    process.stdout.write(
      JSON.stringify({
        error: Boolean(result.isError),
        body: JSON.parse(result.content[0].text),
      }),
    );
  } else {
    const result = await client.callTool({
      name: "proposal_review_get",
      arguments: { kind: "brain", proposalId },
    });

    if (profile === "personal-knowledge" && !result.isError) {
      const item = JSON.parse(result.content[0].text);
      const decision = await client.callTool({
        name: "proposal_review_decide",
        arguments: {
          kind: "brain",
          proposalId,
          expectedVersion: item.version,
          decision: "accept",
          requestKey: "mcp-personal-brain",
        },
      });

      process.stdout.write(
        JSON.stringify({
          tools: listed.tools,
          error: Boolean(decision.isError),
          ...(decision.isError
            ? { diagnostic: decision.content[0].text }
            : { receipt: JSON.parse(decision.content[0].text) }),
        }),
      );
    } else {
      process.stdout.write(
        JSON.stringify({
          tools: listed.tools,
          error: Boolean(result.isError),
          diagnostic: result.content[0]?.text,
        }),
      );
    }
  }
} finally {
  await client.close();
}
