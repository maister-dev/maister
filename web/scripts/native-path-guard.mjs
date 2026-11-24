import { pathToFileURL } from "node:url";

import { runNativePathGuard } from "../../runtime/native-path-guard.mjs";

export * from "../../runtime/native-path-guard.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runNativePathGuard();
}
