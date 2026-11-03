import { readFile } from "node:fs/promises";

import { z } from "zod";

const common = z.object({
  pid: z.number().int().gt(1),
  at: z.number().int().nonnegative().optional(),
});
const session = common.extend({ sessionId: z.string().min(1) });

export const adapterInvocationSchema = z.discriminatedUnion("method", [
  common.extend({ method: z.literal("session/new") }),
  session.extend({
    method: z.literal("session/prompt"),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    terminalBarrier: z.string().min(1).optional(),
  }),
  session.extend({
    method: z.enum([
      "session/prompt/terminal-held",
      "session/prompt/terminal-released",
    ]),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    terminalBarrier: z.string().min(1),
    at: z.number().int().nonnegative(),
    outcome: z.enum(["complete", "cancelled"]).optional(),
  }),
  session.extend({
    method: z.enum([
      "session/cancel",
      "session/cancel/processed",
      "unowned/stopped",
      "unowned/permission",
      "_session/steering",
      "_session/steering/received",
    ]),
  }),
]);

export type AdapterInvocation = z.infer<typeof adapterInvocationSchema>;
export type AdapterPromptInvocation = Extract<
  AdapterInvocation,
  { method: "session/prompt" }
>;

/** A newline commits one method-specific adapter effect; partial appends are not witnesses. */
export async function readAdapterInvocations(
  filename: string,
): Promise<AdapterInvocation[]> {
  let contents: string;

  try {
    contents = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return contents
    .slice(0, contents.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((line) => adapterInvocationSchema.parse(JSON.parse(line) as unknown));
}

export async function readAdapterPrompts(
  filename: string,
): Promise<AdapterPromptInvocation[]> {
  return (await readAdapterInvocations(filename)).filter(
    (row): row is AdapterPromptInvocation => row.method === "session/prompt",
  );
}
