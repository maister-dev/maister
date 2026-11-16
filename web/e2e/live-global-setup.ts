import { z } from "zod";

const healthSchema = z.object({
  status: z.literal("ready"),
  host: z.object({
    hostKey: z.literal("eh_e2e_live_supervisor"),
    bootId: z.string().min(1),
    protocolVersion: z.literal(1),
  }),
});

/** The live lane uses only its real, owned supervisor; it starts no fixture daemon. */
export default async function liveGlobalSetup(): Promise<void> {
  if (process.env.E2E_LIVE_SUPERVISOR !== "1")
    throw new Error(
      "The live qualification lane requires E2E_LIVE_SUPERVISOR=1",
    );

  const port = process.env.MAISTER_SUPERVISOR_PORT ?? "7777";
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok)
    throw new Error(
      `Live supervisor health failed with HTTP ${response.status}`,
    );
  healthSchema.parse(await response.json());
}
