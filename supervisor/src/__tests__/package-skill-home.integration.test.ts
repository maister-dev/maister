import type { AddressInfo } from "node:net";

import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";

import { packageSkillTreeDigest } from "../../../runtime/package-skill-tree";

import {
  adoptDirectory,
  bootHost,
  createSession,
  fenceFor,
} from "./_fixtures/boot-host";

it("IT-CAP-04 sends distinct ACP IDs, progressive discovery companions and selected MCPs to overlapping session agents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maister-caps-host-"));
  const log = path.join(root, "invocations.jsonl");
  const host = await bootHost({
    runtimeRoot: root,
    fixtureArgs: [
      "--inspect-package-skills",
      "--invocation-log",
      log,
      "--supports-resume",
    ],
  });
  const called: string[] = [];
  const endpoint = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();

      return;
    }
    const server = new Server(
      { name: "package-witness", version: "1" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "read_companion",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      called.push(req.url + ":" + params.arguments?.value);

      return { content: [{ type: "text", text: "accepted" }] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
    await server.close();
  });

  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  try {
    const runId = "scoped-run",
      fence = fenceFor(host, runId);
    const cwd = path.join(root, "checkout");

    await adoptDirectory(host, fence, { dir: cwd });
    const inputs = await Promise.all(
      ["design", "build"].map(async (slug) => {
        const dir = path.join(
          cwd,
          ".maister",
          "capabilities",
          runId,
          slug,
          "package-skills",
        );

        await mkdir(path.join(dir, slug), { recursive: true });
        await writeFile(path.join(dir, slug, "SKILL.md"), "Read companion.md");
        await writeFile(path.join(dir, slug, "companion.md"), slug);

        return {
          nodeAttemptId: slug,
          sessionName: "bound-" + slug,
          stepId: slug,
          executor: { agent: "claude", model: "test" },
          packageSkillView: { skillsDigest: await packageSkillTreeDigest(dir) },
          mcpServers: [
            {
              name: slug,
              transport: "http",
              url: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/${slug}`,
              headers: {},
            },
          ],
        };
      }),
    );
    const sessions = await Promise.all(
      inputs.map((input) => createSession(host, fence, input)),
    );

    expect(new Set(sessions.map((s) => s.acpSessionId)).size).toBe(2);
    expect(called.sort()).toEqual(["/build:build", "/design:design"]);
    const discoveries = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.method === "native-discovery");

    expect(new Set(discoveries.map((d) => d.home)).size).toBe(2);
    expect(discoveries.map(({ skills, mcps }) => ({ skills, mcps }))).toEqual(
      expect.arrayContaining(
        ["build", "design"].map((slug) => ({
          skills: [{ slug, companion: slug }],
          mcps: [slug],
        })),
      ),
    );
    const resumed = await createSession(host, fence, {
      ...inputs[0],
      resumeSessionId: sessions[0]!.acpSessionId,
    });

    expect(resumed.acpSessionId).toBe(sessions[0]!.acpSessionId);
  } finally {
    await host.stop();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      endpoint.close((err) => (err ? reject(err) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
