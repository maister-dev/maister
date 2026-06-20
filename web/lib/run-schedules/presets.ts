export const RUN_SCHEDULE_PRESETS = [
  { id: "hourly", cronExpr: "0 * * * *" },
  { id: "dailyMorning", cronExpr: "0 9 * * *" },
  { id: "weekdayMorning", cronExpr: "0 9 * * 1-5" },
  { id: "weekly", cronExpr: "0 9 * * 1" },
  { id: "custom", cronExpr: "" },
] as const;

export type RunSchedulePresetId = (typeof RUN_SCHEDULE_PRESETS)[number]["id"];

export function presetForCronExpr(cronExpr: string): RunSchedulePresetId {
  const preset = RUN_SCHEDULE_PRESETS.find((item) => {
    return item.id !== "custom" && item.cronExpr === cronExpr;
  });

  return preset?.id ?? "custom";
}
