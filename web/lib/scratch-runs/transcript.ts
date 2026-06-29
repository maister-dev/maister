// Re-export shim (T-B1). The canonical transcript substrate now lives in
// `lib/run-transcript/transcript.ts` and is shared by scratch AND flow. Existing
// scratch importers keep using `@/lib/scratch-runs/transcript` unchanged.
export * from "@/lib/run-transcript/transcript";
