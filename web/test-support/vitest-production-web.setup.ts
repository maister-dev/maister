import { buildProductionWeb } from "./real-web";

export default async function setup(): Promise<void> {
  const logFile = process.env.MAISTER_ISOLATION_WEB_BUILD_LOG;

  if (!logFile)
    throw new Error("Isolation lane production build log is required");
  await buildProductionWeb(logFile);
}
