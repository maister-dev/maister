// Re-export shim (T-B1). The canonical transcript renderer now lives in
// `components/run-transcript/transcript-view.tsx` as `TranscriptView`, shared by
// scratch AND flow. Existing scratch importers keep the `ScratchTranscript`
// name + transcript types unchanged.
export {
  TranscriptView as ScratchTranscript,
  TranscriptView,
} from "@/components/run-transcript/transcript-view";
export type {
  TranscriptMessage,
  TranscriptLabels,
  TranscriptRole,
  TranscriptAttachmentBadge,
} from "@/components/run-transcript/transcript-view";
