#!/usr/bin/env node
// Offline adapter for the checkout journey. It reads only the discovery roots and MCPs
// passed to this session. Test receipts come from the fixture server and the workspace.
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { serveAgent } from "./acp-agent-app.mjs";

async function selectedSkills(cwd) {
  const roots = [
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".gemini", "skills"),
    ...(process.env.CLAUDE_CONFIG_DIR
      ? [path.join(process.env.CLAUDE_CONFIG_DIR, "skills")]
      : []),
    ...(process.env.CODEX_HOME
      ? [path.join(process.env.CODEX_HOME, "skills")]
      : []),
  ];
  const selected = new Map();
  for (const root of roots) {
    let names;
    try {
      names = await readdir(root);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.filter((n) =>
      [
        "design-journey",
        "engineering-check",
        "core-conventions",
        "design-unused",
      ].includes(n),
    )) {
      const directory = path.join(root, name);
      await readFile(path.join(directory, "SKILL.md"), "utf8");
      selected.set(
        name,
        (await readFile(path.join(directory, "marker.txt"), "utf8")).trim(),
      );
    }
  }
  return selected;
}

async function assertNoPrivateDesignConfig(cwd) {
  const files = [
    path.join(cwd, ".mcp.json"),
    path.join(cwd, ".claude", "settings.local.json"),
    ...(process.env.CLAUDE_CONFIG_DIR
      ? [path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json")]
      : []),
    ...(process.env.CODEX_HOME
      ? [path.join(process.env.CODEX_HOME, "config.toml")]
      : []),
  ];
  for (const file of files) {
    try {
      const settings = await readFile(file, "utf8");
      if (settings.includes("design-reference-"))
        throw new Error("Coding adapter configuration included the design MCP");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function call(server, name, args) {
  if (!server) throw new Error(`Missing selected MCP for ${name}`);
  const client = new Client({ name: "checkout-qualification", version: "1" });
  let transport;
  if (server.url) {
    const url = new URL(server.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/mcp"
    )
      throw new Error("Expected fixture-local design MCP");
    transport = new StreamableHTTPClientTransport(url);
  } else {
    if (server.name !== "maister")
      throw new Error("Expected scoped MAIster facade");
    const env = Object.fromEntries(
      (server.env ?? []).map(({ name, value }) => [name, value]),
    );
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env,
      stderr: "inherit",
    });
  }
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (result.isError)
      throw new Error(`Fixture call failed: ${name}: ${text}`);
    return text;
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        fixture: "checkout-delivery",
        tool: name,
        error: String(error),
      }) + "\n",
    );
    throw error;
  } finally {
    await client.close();
  }
}

serveAgent(
  (connection) => {
    const sessions = new Map();
    let cancel;
    return {
      initialize: async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          promptCapabilities: {},
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {}, list: {} },
          loadSession: true,
        },
      }),
      async newSession(params) {
        const sessionId = randomUUID();
        sessions.set(sessionId, params);
        return { sessionId };
      },
      async resumeSession(params) {
        sessions.set(params.sessionId, params);
        return {};
      },
      async loadSession(params) {
        sessions.set(params.sessionId, params);
        return {};
      },
      async listSessions() {
        return { sessions: [] };
      },
      async setSessionMode() {
        return {};
      },
      async setSessionConfigOption() {
        return { configOptions: [] };
      },
      async authenticate() {
        return {};
      },
      async cancel() {
        cancel?.();
      },
      async prompt({ sessionId, prompt }) {
        const session = sessions.get(sessionId);
        if (!session) throw new Error("Unknown checkout qualification session");
        const text = prompt
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const goals = await selectedSkills(session.cwd);
        const design = session.mcpServers.find((s) =>
          s.name.startsWith("design-reference-"),
        );
        if (goals.has("design-unused"))
          throw new Error("Unselected design skill was discoverable");
        const journey = text.match(/Guest checkout [a-f0-9-]{36}/)?.[0];
        if (journey) {
          if (!goals.has("design-journey"))
            throw new Error("Resume lost designer skill");
          const reference = await call(design, "read_design_reference", {});
          await writeFile(
            path.join(session.cwd, "prototype.html"),
            `<title>Checkout</title><h1>${journey}</h1><a href="#payment">Next step</a><section id="payment">Payment</section><p>${goals.get("design-journey")}</p><p>${reference}</p>`,
          );
        } else if (text.includes("ask_human to ask which checkout journey")) {
          if (!design || !goals.has("design-journey")) {
            process.stderr.write(
              JSON.stringify({
                fixture: "checkout-delivery",
                designServer: Boolean(design),
                designSkill: goals.has("design-journey"),
              }) + "\n",
            );
            throw new Error("Design scope missing");
          }
          const stopped = new Promise((resolve) => {
            cancel = resolve;
          });
          await call(
            session.mcpServers.find((s) => s.name === "maister"),
            "ask_human",
            {
              requestKey: "checkout-journey",
              question: "Which checkout journey should the prototype cover?",
              schema: {
                schemaVersion: 1,
                fields: [
                  {
                    name: "journey",
                    type: "string",
                    required: true,
                    label: "Journey",
                    options: ["Member checkout"],
                  },
                ],
              },
            },
          );
          await stopped;
          return { stopReason: "cancelled" };
        } else if (text.includes("verification.txt")) {
          await assertNoPrivateDesignConfig(session.cwd);
          if (
            design ||
            goals.has("design-journey") ||
            !goals.has("engineering-check") ||
            !goals.has("core-conventions")
          )
            throw new Error("Incorrect coding session inventory");
          await writeFile(
            path.join(session.cwd, "verification.txt"),
            [
              goals.get("engineering-check"),
              goals.get("core-conventions"),
            ].join("\n"),
          );
        } else if (text.includes("designer.txt")) {
          if (
            !design ||
            goals.has("core-conventions") ||
            goals.has("engineering-check") ||
            !goals.has("design-journey")
          )
            throw new Error("Incorrect standalone inventory");
          const extra = session.mcpServers.find((server) =>
            server.name.startsWith("instance-reference-"),
          );
          if (!extra) throw new Error("Standalone instance addition missing");
          const ref = await call(extra, "read_design_reference", {});
          await writeFile(
            path.join(session.cwd, "designer.txt"),
            [goals.get("design-journey"), extra.name, ref].join("\n"),
          );
        } else {
          throw new Error("Unexpected checkout qualification prompt");
        }
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Completed the requested fixture artifact.",
            },
          },
        });
        return { stopReason: "end_turn" };
      },
    };
  },
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ),
);
