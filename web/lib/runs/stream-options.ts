const LIVE_REPLAY_VALUES = new Set(["0", "false", "live"]);

export function shouldReplayRunStream(url: string): boolean {
  const value = new URL(url, "http://localhost").searchParams.get("replay");

  return value ? !LIVE_REPLAY_VALUES.has(value.toLowerCase()) : true;
}

export function streamReadyEvent(): {
  type: "session.stream_ready";
  replay: false;
} {
  return { type: "session.stream_ready", replay: false };
}
