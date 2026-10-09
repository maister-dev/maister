import type { Invocation } from "./process-invocation";

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SupervisorSentinelWitness = Readonly<{
  nodeOptions: string;
  verify(supervisorPid: number): Promise<void>;
}>;

/** A fixture-only preload proves the actual supervisor read the private sentinel. */
export async function prepareSupervisorSentinelWitness(
  invocation: Invocation,
  sentinel: string,
): Promise<SupervisorSentinelWitness> {
  const bytes = await readFile(sentinel);
  const digest = createHash("sha256")
    .update(new Uint8Array(bytes))
    .digest("hex");
  const id = randomUUID();
  const preload = path.join(invocation.directory, `sentinel-witness-${id}.mjs`);
  const receipt = path.join(
    invocation.directory,
    `sentinel-witness-${id}.json`,
  );
  const source = `
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const bytes = readFileSync(${JSON.stringify(sentinel)});
const witness = { invocationId: process.env.MAISTER_TEST_WORKTREE_INVOCATION_ID, pid: process.pid, bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };
const temporary = ${JSON.stringify(`${receipt}.tmp`)};
writeFileSync(temporary, JSON.stringify(witness), {flag:'wx',mode:0o600});
renameSync(temporary, ${JSON.stringify(receipt)});
process.stderr.write(JSON.stringify({event:'supervisor-sentinel-read', ...witness}) + '\\n');
delete process.env.NODE_OPTIONS;
`;

  await writeFile(preload, source, { flag: "wx", mode: 0o600 });

  return {
    nodeOptions: `--import ${JSON.stringify(preload)}`,
    async verify(supervisorPid: number): Promise<void> {
      const actual: unknown = JSON.parse(await readFile(receipt, "utf8"));

      if (
        typeof actual !== "object" ||
        actual === null ||
        !("invocationId" in actual) ||
        actual.invocationId !== invocation.id ||
        !("pid" in actual) ||
        actual.pid !== supervisorPid ||
        !("bytes" in actual) ||
        actual.bytes !== bytes.length ||
        !("digest" in actual) ||
        actual.digest !== digest ||
        Object.keys(actual).length !== 4
      )
        throw new Error(
          "private sentinel witness does not match the registered real supervisor",
        );
    },
  };
}
