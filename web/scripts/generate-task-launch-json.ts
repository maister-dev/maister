import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";
import { format } from "prettier";

import {
  taskLaunchBodySchema,
  taskLaunchCancelBodySchema,
  taskLaunchReplaceBodySchema,
  taskLaunchOptionsSchema,
} from "../lib/tasks/launch-schema";

const schemas = {
  launch: taskLaunchBodySchema,
  cancel: taskLaunchCancelBodySchema,
  replace: taskLaunchReplaceBodySchema,
  options: taskLaunchOptionsSchema,
};
const exported = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, { target: "draft-07", io: "input" }),
  ]),
);
const target = resolve(
  process.cwd(),
  "../runtime/task-launch-inputs.schema.json",
);
const content = await format(JSON.stringify(exported), { parser: "json" });

if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== content)
    throw new Error(
      "Task launch MCP schemas are stale; run pnpm --filter maister-web generate:task-launch-schema",
    );
} else await writeFile(target, content);
