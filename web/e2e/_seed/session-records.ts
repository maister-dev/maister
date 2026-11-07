import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const sessionRecordSchema = z
  .object({
    sessionId: z.uuid(),
    acpSessionId: z.string().min(1),
    request: z
      .object({
        runId: z.string().min(1),
        agentKind: z.enum(["operational", "code_delivery"]).optional(),
        readOnlySession: z.boolean().optional(),
        autoApprovePermissions: z.boolean().optional(),
        runner: z
          .object({
            runnerId: z.string().optional(),
            model: z.string().optional(),
            adapter: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    prompts: z.array(z.object({ prompt: z.string() }).passthrough()),
  })
  .passthrough();

export type StubSessionRecord = z.infer<typeof sessionRecordSchema>;

export class StubSessionRecordError extends Error {
  readonly name = "StubSessionRecordError";
}

/** Both controlled supervisors write UUID.json session records. Other typed
 * fixture files share this directory but are not session records. A malformed
 * canonical file is a fixture failure, never a record to silently skip.
 */
export function readStubSessionRecords(directory: string): StubSessionRecord[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory)
    .filter((name) =>
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/.test(name),
    )
    .map((name) => {
      const source = readFileSync(path.join(directory, name), "utf8");
      const message = `Invalid controlled supervisor session record: ${name}`;
      let decoded: unknown;

      try {
        decoded = JSON.parse(source);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new StubSessionRecordError(message);
      }
      const parsed = sessionRecordSchema.safeParse(decoded);

      if (!parsed.success || parsed.data.sessionId !== name.slice(0, -5))
        throw new StubSessionRecordError(message);

      return parsed.data;
    });
}
