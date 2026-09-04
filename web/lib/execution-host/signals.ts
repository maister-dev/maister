import type { SupervisorEvent } from "@/lib/supervisor-client";

import { EventEmitter } from "node:events";

// A signal is only a post-commit wake hint. Prompt state and result are always
// re-read from `execution_commands`, so a missed process-local wake cannot
// lose or fabricate a turn outcome after a web restart.
class CommandSignalBus {
  private readonly emitter = new EventEmitter();
  private readonly legacyEmitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  wake(commandId: string): void {
    this.emitter.emit(commandId);
  }

  // B3 compatibility only: the singular long-lived prompt route needs the
  // accepted transition while it waits for its HTTP result. Terminal payloads
  // are never consumed here; canonical runs use `wake` after a DB commit.
  publishLegacy(event: SupervisorEvent): void {
    if (event.type !== "session.command") return;
    this.legacyEmitter.emit(event.commandId, event);
  }

  subscribe(
    commandId: string,
    listener: () => void,
  ): () => void {
    this.emitter.on(commandId, listener);

    return () => {
      this.emitter.off(commandId, listener);
    };
  }

  subscribeLegacy(
    commandId: string,
    listener: (event: Extract<SupervisorEvent, { type: "session.command" }>) => void,
  ): () => void {
    this.legacyEmitter.on(commandId, listener);

    return () => {
      this.legacyEmitter.off(commandId, listener);
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
