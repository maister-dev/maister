export function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

export interface DocumentVisibilityHandlers {
  onHide: () => void;
  onShow: () => void;
  syncInitialHidden?: boolean;
}

export function subscribeDocumentVisibility({
  onHide,
  onShow,
  syncInitialHidden = false,
}: DocumentVisibilityHandlers): () => void {
  if (typeof document === "undefined") return () => {};

  const handleVisibilityChange = (): void => {
    if (isDocumentHidden()) onHide();
    else onShow();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  if (syncInitialHidden && isDocumentHidden()) onHide();

  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
