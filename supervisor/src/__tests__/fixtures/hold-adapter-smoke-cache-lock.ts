import { withSqliteFileLock as withAdapterSmokeCacheLock } from "../../sqlite-file-lock";

const cachePath = process.argv[2];

if (!cachePath) {
  throw new Error("cache path is required");
}

await withAdapterSmokeCacheLock(cachePath, async () => {
  process.stdout.write("acquired\n");
  await new Promise<void>(() => undefined);
});
