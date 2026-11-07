import type { taskLaunchIntents, tasks } from "@/lib/db/schema";

/** A fresh human decision can relaunch the terminal status it actually accepted. */
export function taskLaunchAllowsTaskStatus(
  intent: Pick<
    typeof taskLaunchIntents.$inferSelect,
    "basis" | "settingsSnapshot"
  >,
  status: typeof tasks.$inferSelect.status,
): boolean {
  return (
    status === "Backlog" ||
    status === "InFlight" ||
    (intent.basis.kind === "manual" &&
      intent.settingsSnapshot.version === 2 &&
      intent.settingsSnapshot.acceptedTaskStatus === status)
  );
}
