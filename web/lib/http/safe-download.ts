// The manager's view of the shared AB-12 download policy (`runtime/`), so web
// routes import it by alias like every other `@/lib/http` helper.
export {
  safeDownloadFileName,
  safeDownloadHeaders,
  type SafeDownloadFileName,
  type SafeDownloadMediaClass,
} from "../../../runtime/safe-download";
