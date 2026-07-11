#!/usr/bin/env node
// A minimal MCP stdio server for probe tests. Speaks newline-delimited JSON-RPC.
// `mode` (argv[2]): "ok" responds to initialize; "hang" reads but never responds
// (so the client's handshake times out and the probe must kill this child).
const mode = process.argv[2] ?? "ok";

process.stdin.setEncoding("utf8");

let buf = "";

process.stdin.on("data", (chunk) => {
  buf += chunk;

  let idx;

  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();

    buf = buf.slice(idx + 1);
    if (!line) continue;

    let msg;

    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (mode === "hang") continue;

    if (msg.method === "initialize") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
            capabilities: {},
            serverInfo: { name: "fake-mcp", version: "9.9.9" },
          },
        }) + "\n",
      );
    }
  }
});
