// M19 Phase 5: pure TTL derivation for the left-rail GC countdown badge. Given a
// run's status + timestamps and the configured gcAgeDays/gcWarningDays windows,
// returns the ttlState, the effective removal date, and the archived/pruned
// flags. Clock-free and db-free — the caller injects `nowMs`. Live
// (non-terminal) runs NEVER count down.

const DAY_MS = 86_400_000;

const TERMINAL_STATUSES = new Set(["Abandoned", "Done"]);

export interface TtlInfo {
  ttlState: "active" | "warning" | "due";
  effectiveRemovalAt: Date | null;
  archived: boolean;
  pruned: boolean;
}

export function deriveTtlInfo(args: {
  status: string;
  endedAt: Date | null;
  scheduledRemovalAt: Date | null;
  archivedBranch: string | null;
  removedAt: Date | null;
  nowMs: number;
  ageDays: number;
  warningDays: number;
}): TtlInfo {
  const archived = args.archivedBranch != null;
  const pruned = args.removedAt != null;

  if (!TERMINAL_STATUSES.has(args.status)) {
    return { ttlState: "active", effectiveRemovalAt: null, archived, pruned };
  }

  const effective =
    args.scheduledRemovalAt ??
    (args.endedAt
      ? new Date(args.endedAt.getTime() + args.ageDays * DAY_MS)
      : null);

  if (!effective) {
    return { ttlState: "active", effectiveRemovalAt: null, archived, pruned };
  }

  const effectiveMs = effective.getTime();

  let ttlState: TtlInfo["ttlState"];

  if (args.nowMs >= effectiveMs) {
    ttlState = "due";
  } else if (args.nowMs >= effectiveMs - args.warningDays * DAY_MS) {
    ttlState = "warning";
  } else {
    ttlState = "active";
  }

  return { ttlState, effectiveRemovalAt: effective, archived, pruned };
}
