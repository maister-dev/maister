import type { SupervisorEvent } from "@/lib/supervisor-client";

import { EventEmitter } from "node:events";

// ADR-165 D5: the `session.command` events observed on any SSE consumer are
// published here so a prompt's `PromptHandle.completion` resolves from
// whichever durable signal arrives first (SSE, receipt, or the HTTP response).
// Process-local by design — the durable copies live in the ledger and in
// `run.events.jsonl`.

export type SessionCommandEvent = Extract<
  SupervisorEvent,
  { type: "session.command" }
>;

class CommandSignalBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: SupervisorEvent): void {
    if (event.type !== "session.command") return;
    this.emitter.emit(event.commandId, event);
  }

  subscribe(
    commandId: string,
    listener: (event: SessionCommandEvent) => void,
  ): () => void {
    this.emitter.on(commandId, listener);

    return () => {
      this.emitter.off(commandId, listener);
    };
  }
}

declare global {
  var __maisterCommandSignals: CommandSignalBus | undefined;
}

// HMR-safe singleton (mirrors the sweeper handles on globalThis).
export const commandSignals: CommandSignalBus =
  globalThis.__maisterCommandSignals ?? new CommandSignalBus();

globalThis.__maisterCommandSignals = commandSignals;
