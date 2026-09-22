import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { FIXTURE_WATCHDOG } from "../process-invocation.ts";

// Private falsification preload: remove only the watchdog import from fixture
// spawn arguments. It is never selected by the public lane or production boot.
const originalSpawn = childProcess.spawn;

childProcess.spawn = (file, args, options) => {
  const filtered = args.filter((argument, index) => argument !== FIXTURE_WATCHDOG && !(argument === "--import" && args[index + 1] === FIXTURE_WATCHDOG));

  return originalSpawn(file, filtered, options);
};
syncBuiltinESMExports();
