import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { taskQualificationValueSchema } from "../lib/tasks/qualification-schema";

const schema = z.toJSONSchema(taskQualificationValueSchema, {
  target: "draft-07",
  io: "input",
});

const target = resolve(
  process.cwd(),
  "../runtime/task-qualification.schema.json",
);
const content = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== content)
    throw new Error(
      "Task qualification MCP schema is stale; run pnpm --filter maister-web generate:qualification-schema",
    );
} else await writeFile(target, content);
