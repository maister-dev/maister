import {
  encodeThoughtPayload,
  encodeToolPayload,
  encodeUsagePayload,
  interpretSessionUpdate,
  type ScratchToolStatus,
} from "@/lib/run-transcript/transcript";

// Pure transcript coalescer (T-B2). This is the batch counterpart to the live
// scratch consumer's `createTranscriptProjector` (lib/scratch-runs/events.ts):
// it runs the SAME `interpretSessionUpdate` classifier + the SAME encoders, and
// applies the SAME coalescing rules (streamed assistant/thought chunks merge
// into one message; a `tool_call` + its `tool_call_update`s merge by
// toolCallId; usage collapses to one row). The difference is shape, not logic:
// the live consumer writes/updates DB rows incrementally over a never-resuming
// stream, whereas a flow run is reconciled-on-read from the durable
// `run.events.jsonl`, so this function re-derives the FULL ordered message list
// deterministically. `sequence` is the message's position, which makes the
// projector's upsert idempotent under the `(run_id, node_attempt_id, sequence)`
// unique index.

export type TranscriptRole = "user" | "assistant" | "tool" | "system";

export type CoalescedMessage = {
  sequence: number;
  role: TranscriptRole;
  content: string;
  supervisorEventId: string;
};

// One log entry fed to the coalescer. A `reset` marks a boundary (permission
// request / hook trip / session exit) after which streamed assistant/thought
// chunks start a NEW message — mirroring the live consumer's `resetOpenText()`.
export type CoalesceEntry =
  | { kind: "update"; update: unknown; supervisorEventId: string }
  | { kind: "reset" };

type ToolState = {
  name: string;
  toolKind: string;
  status: ScratchToolStatus;
  arg: string;
  rawInput: unknown;
  result: string;
};

export function coalesceSessionUpdates(
  entries: readonly CoalesceEntry[],
): CoalescedMessage[] {
  const messages: CoalescedMessage[] = [];
  let openText: { idx: number; text: string } | null = null;
  let openThought: { idx: number; text: string } | null = null;
  let usageIdx: number | null = null;
  const toolsByCallId = new Map<string, { idx: number; state: ToolState }>();

  const push = (
    role: TranscriptRole,
    content: string,
    supervisorEventId: string,
  ): number => {
    const sequence = messages.length;

    messages.push({ sequence, role, content, supervisorEventId });

    return sequence;
  };

  const setContent = (
    idx: number,
    content: string,
    supervisorEventId: string,
  ): void => {
    messages[idx].content = content;
    messages[idx].supervisorEventId = supervisorEventId;
  };

  for (const entry of entries) {
    if (entry.kind === "reset") {
      openText = null;
      openThought = null;
      continue;
    }

    const interpreted = interpretSessionUpdate(entry.update);

    if (!interpreted) continue;
    const eid = entry.supervisorEventId;

    switch (interpreted.kind) {
      case "text": {
        openThought = null;
        if (openText) {
          openText.text += interpreted.text;
          setContent(openText.idx, openText.text, eid);
        } else {
          const idx = push("assistant", interpreted.text, eid);

          openText = { idx, text: interpreted.text };
        }
        break;
      }
      case "thought": {
        openText = null;
        if (openThought) {
          openThought.text += interpreted.text;
          setContent(
            openThought.idx,
            encodeThoughtPayload(openThought.text),
            eid,
          );
        } else {
          const idx = push(
            "system",
            encodeThoughtPayload(interpreted.text),
            eid,
          );

          openThought = { idx, text: interpreted.text };
        }
        break;
      }
      case "tool_call": {
        openText = null;
        openThought = null;
        const state: ToolState = {
          name: interpreted.name,
          toolKind: interpreted.toolKind,
          status: interpreted.status,
          arg: interpreted.arg,
          rawInput: interpreted.rawInput,
          result: interpreted.result,
        };
        const idx = push("tool", encodeToolPayload(state), eid);

        toolsByCallId.set(interpreted.toolCallId, { idx, state });
        break;
      }
      case "tool_update": {
        const existing = toolsByCallId.get(interpreted.toolCallId);

        if (!existing) {
          const state: ToolState = {
            name: interpreted.name ?? "tool",
            toolKind: interpreted.toolKind ?? "other",
            status: interpreted.status ?? "pending",
            arg: interpreted.arg ?? "",
            rawInput: interpreted.rawInput ?? null,
            result: interpreted.result ?? "",
          };
          const idx = push("tool", encodeToolPayload(state), eid);

          toolsByCallId.set(interpreted.toolCallId, { idx, state });
          break;
        }

        const { state } = existing;

        if (interpreted.name) state.name = interpreted.name;
        if (interpreted.toolKind) state.toolKind = interpreted.toolKind;
        if (interpreted.status) state.status = interpreted.status;
        if (interpreted.arg && !state.arg) state.arg = interpreted.arg;
        if (interpreted.rawInput !== undefined) {
          state.rawInput = interpreted.rawInput;
        }
        if (interpreted.result) {
          state.result = state.result
            ? `${state.result}\n${interpreted.result}`
            : interpreted.result;
        }
        setContent(existing.idx, encodeToolPayload(state), eid);
        break;
      }
      case "usage": {
        const content = encodeUsagePayload(interpreted.used, interpreted.size);

        if (usageIdx !== null) {
          setContent(usageIdx, content, eid);
        } else {
          usageIdx = push("system", content, eid);
        }
        break;
      }
    }
  }

  return messages;
}
