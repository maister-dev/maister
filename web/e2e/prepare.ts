/* eslint-disable no-console */
import { prepareE2eDatabase } from "./_seed/prepare-db";

prepareE2eDatabase().catch((err) => {
  console.error("e2e preflight failed:", err);
  process.exit(1);
});
