import { withAdapterSmokeCacheLock } from "../../adapter-smoke-cache-lock";

const cachePath = process.argv[2];

if (!cachePath) {
  throw new Error("cache path is required");
}

await withAdapterSmokeCacheLock(cachePath, async () => {
  process.stdout.write("acquired\n");
  await new Promise<void>(() => undefined);
});
