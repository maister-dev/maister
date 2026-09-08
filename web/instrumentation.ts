// Next.js 16+ instrumentation hook — runs once per server process boot.
//
// Next compiles this file for BOTH the Node and the Edge runtime (dev builds
// `instrumentation.edge` eagerly at every boot) and resolves every `import()`
// it can see in the module — an early `return` hides nothing from the bundler.
// Only the body of the `NEXT_RUNTIME === "nodejs"` branch below is dropped
// from the Edge build, so the whole Node-only boot sequence lives in
// ./instrumentation-node and is reached solely through that branch. Anything
// imported outside it drags pg/fs/child_process into the Edge bundle and
// floods dev boot with "node module in edge runtime" warnings
// (lib/__tests__/instrumentation.test.ts pins this shape).

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { registerNodeRuntime } = await import("./instrumentation-node");

      await registerNodeRuntime();
    } catch (error) {
      const { failApplicationStartup } = await import("@/lib/server-lifecycle");

      failApplicationStartup(error);
      throw error;
    }
  }
}
