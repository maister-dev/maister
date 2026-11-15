// ADR-208: Run duration and execution time as interval algebra over recorded
// evidence. Union-based, so parallel attempts and retries never exceed wall
// clock; missing evidence is `unavailable`, never 0.

export type Interval = { start: number; end: number | null };

export type RunTimingEvidence = {
  startedAt: number;
  endedAt: number | null;
  now: number;
  // Own execution: non-human node attempts (flow) or agent turns (agent/scratch).
  execution: Interval[];
  // Child Runs' execution; counts only inside this Run's window.
  childExecution: Interval[];
  hitl: Interval[];
  checkpoints: Interval[];
};

export type RunTimingQuality = "exact" | "partial" | "unavailable";

export type RunTimingBreakdown = {
  admissionMs: number;
  humanInputMs: number;
  idleMs: number;
  // Part of execution contributed only by child Runs.
  childExecutionMs: number;
  otherMs: number;
};

export type RunTiming = {
  durationMs: number;
  live: boolean;
  executionMs: number | null;
  quality: RunTimingQuality;
  breakdown: RunTimingBreakdown | null;
};

type Span = { start: number; end: number };

function clip(intervals: Interval[], window: Span): Span[] {
  return intervals
    .map((i) => ({
      start: Math.max(i.start, window.start),
      end: Math.min(i.end ?? window.end, window.end),
    }))
    .filter((s) => s.end > s.start);
}

function union(spans: Span[]): Span[] {
  const merged: Span[] = [];

  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);

    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  return merged;
}

function subtract(from: Span[], minus: Span[]): Span[] {
  let result = union(from);

  for (const cut of union(minus)) {
    result = result.flatMap((s) => {
      if (cut.end <= s.start || cut.start >= s.end) return [s];

      return [
        { start: s.start, end: cut.start },
        { start: cut.end, end: s.end },
      ].filter((part) => part.end > part.start);
    });
  }

  return result;
}

function measure(spans: Span[]): number {
  return union(spans).reduce((sum, s) => sum + (s.end - s.start), 0);
}

export function computeRunTiming(e: RunTimingEvidence): RunTiming {
  const live = e.endedAt === null;
  const window: Span = {
    start: e.startedAt,
    end: Math.max(e.startedAt, e.endedAt ?? e.now),
  };
  const durationMs = window.end - window.start;
  const own = clip(e.execution, window);
  const children = clip(e.childExecution, window);
  const executing = union([...own, ...children]);

  if (executing.length === 0) {
    return {
      durationMs,
      live,
      executionMs: null,
      quality: "unavailable",
      breakdown: null,
    };
  }

  const admission: Span[] = [{ start: window.start, end: executing[0].start }];
  const human = union(clip(e.hitl, window));
  const idle = union(clip(e.checkpoints, window));
  const waits = [...admission, ...human, ...idle];
  const execution = subtract(executing, waits);
  const executionMs = measure(execution);
  const admissionMs = measure(admission);
  const humanInputMs = measure(subtract(human, admission));
  const idleMs = measure(subtract(idle, [...admission, ...human]));
  // A terminal Run whose evidence left an interval open was clipped to ended_at.
  const openOnTerminal =
    !live && [...e.execution, ...e.childExecution].some((i) => i.end === null);

  return {
    durationMs,
    live,
    executionMs,
    quality: openOnTerminal ? "partial" : "exact",
    breakdown: {
      admissionMs,
      humanInputMs,
      idleMs,
      childExecutionMs: measure(subtract(execution, own)),
      otherMs: Math.max(
        0,
        durationMs - executionMs - admissionMs - humanInputMs - idleMs,
      ),
    },
  };
}
