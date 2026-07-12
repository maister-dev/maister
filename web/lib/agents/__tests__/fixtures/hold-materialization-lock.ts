import { tryAcquireMaterializationLock } from "../../materialization-lock";

const rootPath = process.argv[2];

if (!rootPath) {
  throw new Error("materialization lock root path is required");
}

const handle = await tryAcquireMaterializationLock(rootPath);

if (!handle) {
  throw new Error("materialization lock is already held");
}

process.stdout.write("acquired\n");
setInterval(() => undefined, 1_000);
