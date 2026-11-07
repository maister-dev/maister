import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { RealSupervisor } from "./real-supervisor";
import type { RealWeb } from "./real-web";

import { z } from "zod";

import {
  poll,
  promptCommandsForRun,
  type PromptCommandRow,
} from "./durable-workers-ledger";
import {
  findProcessIdentity,
  invocationFromEnvironment,
  logInvocation,
  processIdentity,
  sameProcess,
  signalInvocationProcess,
  type ProcessIdentity,
} from "./process-invocation";
import { readAdapterInvocations } from "./adapter-invocations";
import { captureOwnedAdapterProcess } from "./capture-supervisor-process-groups";

import { TERMINAL_COMMAND_STATES } from "@/lib/execution-host/types";

const terminalBaseSchema = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  method: z.string().min(1),
  requestSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  terminalBarrier: z.string().min(1).optional(),
  at: z.number().int().nonnegative().optional(),
  outcome: z.enum(["complete", "cancelled"]).optional(),
});
const terminalSchema = terminalBaseSchema.extend({
  method: z.enum([
    "session/prompt/terminal-held",
    "session/prompt/terminal-released",
  ]),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  terminalBarrier: z.string().min(1),
  at: z.number().int().nonnegative(),
});
const sessionSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  pid: z.number().int().positive(),
  adapterPid: z.number().int().positive().optional(),
  acpSessionId: z.string().optional(),
  status: z.enum(["live", "exited", "crashed"]),
});

type TerminalRecord = z.infer<typeof terminalSchema>;
type HeldWitness = Readonly<{
  record: TerminalRecord;
  identity: ProcessIdentity;
  issuer: ProcessIdentity;
  hostSessionId: string;
  commandId: string;
  runId: string;
}>;
type TerminalInput = Readonly<{
  db: NodePgDatabase;
  supervisor: RealSupervisor;
  issuer: RealWeb;
  adapterLog: string;
  token: string;
  timeoutMs: number;
}>;
export type TerminalBarrier = Readonly<{
  waitForHeld: (command: PromptCommandRow) => Promise<void>;
  releaseForApplication: () => Promise<void>;
  releaseAfterWebDeath: () => Promise<void>;
  close: () => Promise<void>;
}>;

class TerminalBarrierError extends Error {
  readonly name = "TerminalBarrierError";
}

async function sessionsFor(input: TerminalInput) {
  const response = await fetch(`${input.supervisor.url}/sessions`);
  const body = await response.text();

  if (!response.ok)
    throw new TerminalBarrierError(
      `session inspection failed: ${response.status} ${body}`,
    );

  return z.array(sessionSchema).parse(JSON.parse(body) as unknown);
}

async function sessionFor(input: TerminalInput, command: PromptCommandRow) {
  const invocation = invocationFromEnvironment();

  if (!invocation || !command.targetSessionId)
    throw new TerminalBarrierError(
      "Terminal command has no owned host session",
    );

  return captureOwnedAdapterProcess({
    invocation,
    supervisor: input.supervisor,
    sessionId: command.targetSessionId,
    expected: { runId: command.runId },
  });
}

/** Owns one real ACP terminal and proves the issuer lifetime required by each release. */
export function createTerminalBarrier(input: TerminalInput): TerminalBarrier {
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new TerminalBarrierError(
      "terminal barrier requires an owning invocation",
    );
  let command: PromptCommandRow | undefined;
  let witness: HeldWitness | undefined;
  let released = false;
  const tokenRows = async () =>
    (await readAdapterInvocations(input.adapterLog)).filter(
      (row) => "terminalBarrier" in row && row.terminalBarrier === input.token,
    );
  const records = async () =>
    (await tokenRows())
      .filter(
        (row) =>
          row.method === "session/prompt/terminal-held" ||
          row.method === "session/prompt/terminal-released",
      )
      .map((row) => terminalSchema.parse(row));
  const capture = async (record: TerminalRecord): Promise<HeldWitness> => {
    if (!command)
      throw new TerminalBarrierError(
        "terminal barrier has no admitted command",
      );
    const { sessionRecord: session, adapter: identity } = await sessionFor(
      input,
      command,
    );

    if (
      identity.pid !== record.pid ||
      session.acpSessionId !== record.sessionId
    )
      throw new TerminalBarrierError(
        `terminal witness does not match command ${command.id}: ${JSON.stringify(record)}`,
      );
    const prompt = (await readAdapterInvocations(input.adapterLog)).find(
      (row) =>
        row.method === "session/prompt" &&
        row.pid === record.pid &&
        row.sessionId === record.sessionId &&
        row.requestSha256 === record.requestSha256,
    );

    if (!prompt)
      throw new TerminalBarrierError(
        `terminal witness lacks its real ACP prompt: ${JSON.stringify(record)}`,
      );
    const issuer = await processIdentity(invocation, input.issuer.pid);

    if (!issuer.owned || !issuer.inspected || issuer.zombie)
      throw new TerminalBarrierError(
        `issuing web identity is not live and owned: ${JSON.stringify(issuer)}`,
      );

    return {
      record,
      identity,
      issuer,
      hostSessionId: session.sessionId,
      commandId: command.id,
      runId: command.runId,
    };
  };
  const release = async (): Promise<void> => {
    if (!witness || !command || released)
      throw new TerminalBarrierError(
        "terminal release requires one unreleased held witness",
      );
    const { sessionRecord: session, adapter: current } = await sessionFor(
      input,
      command,
    );

    if (
      !sameProcess(current, witness.identity) ||
      session.adapterPid !== current.pid ||
      session.sessionId !== witness.hostSessionId ||
      session.acpSessionId !== witness.record.sessionId
    )
      throw new TerminalBarrierError(
        "adapter or session identity changed before terminal release",
      );
    if (
      (await records()).some(
        (row) => row.method === "session/prompt/terminal-released",
      )
    )
      throw new TerminalBarrierError(
        `premature terminal release for ${input.token}`,
      );
    await signalInvocationProcess(invocation, witness.identity, "SIGUSR1");
    const receipt = await poll(
      async () =>
        (await records()).find(
          (row) =>
            row.method === "session/prompt/terminal-released" &&
            row.pid === current.pid &&
            row.sessionId === session.acpSessionId &&
            row.requestSha256 === witness?.record.requestSha256,
        ),
      input.timeoutMs,
      `terminal release for ${command.id}`,
      100,
    );

    if (receipt.outcome !== "complete")
      throw new TerminalBarrierError(
        `terminal ${input.token} was cancelled instead of released`,
      );
    released = true;
    logInvocation(invocation, "durable-terminal-released", {
      role: "fixture",
      caseName: process.env.MAISTER_TEST_CASE_NAME ?? "fixture",
      rootRole: "supervisor",
      bootId: `${input.issuer.buildId}:${input.issuer.pid}`,
      commandId: command.id,
      hostSessionId: session.sessionId,
      ...receipt,
      kernelStartId: current.started,
      issuerPid: input.issuer.pid,
    });
  };
  const releaseAfterWebDeath = async (): Promise<void> => {
    if (!witness)
      throw new TerminalBarrierError(
        "terminal release requires a held witness",
      );
    const currentIssuer = await findProcessIdentity(
      invocation,
      witness.issuer.pid,
    );

    if (
      currentIssuer &&
      sameProcess(currentIssuer, witness.issuer) &&
      !currentIssuer.zombie
    )
      throw new TerminalBarrierError(
        `refusing terminal release before issuing web ${witness.issuer.pid} dies`,
      );
    await release();
  };
  const releaseForApplication = async (): Promise<void> => {
    if (!witness)
      throw new TerminalBarrierError(
        "application release requires a held witness",
      );
    const currentIssuer = await processIdentity(invocation, witness.issuer.pid);

    if (
      !currentIssuer.owned ||
      !currentIssuer.inspected ||
      currentIssuer.zombie ||
      !sameProcess(currentIssuer, witness.issuer)
    )
      throw new TerminalBarrierError(
        "application release requires the original live issuing web",
      );
    await release();
  };

  return {
    waitForHeld: async (accepted) => {
      if (command)
        throw new TerminalBarrierError(
          "terminal barrier already has a command",
        );
      command = accepted;
      witness = await poll(
        async () => {
          const current = (
            await promptCommandsForRun(input.db, accepted.runId)
          ).find((row) => row.id === accepted.id);

          if (!current)
            throw new TerminalBarrierError(
              `admitted command ${accepted.id} disappeared`,
            );
          if (
            current.completionAppliedAt ||
            current.terminalEvidenceSha256 ||
            current.applicationState === "applied" ||
            TERMINAL_COMMAND_STATES.some((state) => state === current.state)
          )
            throw new TerminalBarrierError(
              `premature terminal before web death for command ${accepted.id}: ${JSON.stringify(current)}`,
            );
          const rows = await records();

          if (
            rows.some(
              (row) => row.method === "session/prompt/terminal-released",
            )
          )
            throw new TerminalBarrierError(
              `premature terminal release before web death for ${input.token}`,
            );
          const held = rows.find(
            (row) => row.method === "session/prompt/terminal-held",
          );

          if (!held || current.state !== "accepted") return null;
          command = current;

          return capture(held);
        },
        input.timeoutMs,
        `real ACP terminal held for ${accepted.id}`,
        100,
      );
      logInvocation(invocation, "durable-terminal-held", {
        role: "fixture",
        caseName: process.env.MAISTER_TEST_CASE_NAME ?? "fixture",
        rootRole: "supervisor",
        bootId: `${input.issuer.buildId}:${input.issuer.pid}`,
        commandId: accepted.id,
        hostSessionId: witness.hostSessionId,
        ...witness.record,
        kernelStartId: witness.identity.started,
        issuerPid: witness.issuer.pid,
        issuerKernelStartId: witness.issuer.started,
      });
    },
    releaseForApplication,
    releaseAfterWebDeath,
    close: async () => {
      // Retire the live waiter even when admission or witness inspection failed.
      await input.issuer.kill("SIGKILL");
      if (released) return;
      const rows = await records();

      if (rows.some((row) => row.method === "session/prompt/terminal-released"))
        return;
      const held = rows.find(
        (row) => row.method === "session/prompt/terminal-held",
      );
      const candidate =
        held ??
        (await tokenRows()).find((row) => row.method === "session/prompt");

      if (!candidate) return;
      const identity = await findProcessIdentity(invocation, candidate.pid);

      if (!identity || identity.zombie) return;
      if (witness && !sameProcess(identity, witness.identity))
        throw new TerminalBarrierError(
          "cleanup adapter kernel identity changed",
        );
      const sessions = (await sessionsFor(input)).filter(
        (row) =>
          row.status === "live" &&
          row.adapterPid === candidate.pid &&
          row.acpSessionId === candidate.sessionId,
      );

      if (
        sessions.length !== 1 ||
        (witness &&
          (sessions[0]?.sessionId !== witness.hostSessionId ||
            sessions[0]?.runId !== witness.runId))
      )
        throw new TerminalBarrierError(
          `cleanup terminal has no exact live session: ${JSON.stringify(candidate)}`,
        );
      const session = sessions[0]!;
      const owned = await captureOwnedAdapterProcess({
        invocation,
        supervisor: input.supervisor,
        sessionId: session.sessionId,
        expected: { runId: session.runId, acpSessionId: candidate.sessionId },
      });

      if (!sameProcess(owned.adapter, identity))
        throw new TerminalBarrierError("Cleanup adapter changed before signal");
      if (!held) {
        // A turn interrupted before the held witness cannot remain live in teardown.
        await signalInvocationProcess(invocation, identity, "SIGTERM");
        await poll(
          async () => {
            const current = await findProcessIdentity(invocation, identity.pid);

            return !current || current.zombie || !sameProcess(current, identity)
              ? true
              : null;
          },
          input.timeoutMs,
          `in-flight terminal adapter ${identity.pid} to exit`,
          100,
        );

        return;
      }
      await signalInvocationProcess(invocation, identity, "SIGUSR1");
      await poll(
        async () =>
          (await records()).find(
            (row) =>
              row.method === "session/prompt/terminal-released" &&
              row.pid === held.pid &&
              row.sessionId === held.sessionId &&
              row.requestSha256 === held.requestSha256,
          ),
        input.timeoutMs,
        `cleanup terminal release ${input.token}`,
        100,
      );
    },
  };
}
