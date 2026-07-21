"use client";

import { useEffect, useRef, useState } from "react";

import {
  createLockOpQueue,
  type LockOpQueue,
} from "@/lib/local-packages/lock-op-queue";

// (ADR-149) Shared session edit-lock client for both editors (the local-package
// editor and the authored-capability editor). The server contract is identical
// under both bases: POST <base>/lock-refresh {sessionId, mode} -> lock state,
// POST <base>/lock-release {sessionId}.
export const LOCK_REFRESH_MS = 60_000;

export type EditorLockSnapshot = {
  held: boolean;
  heldByMe: boolean;
  holderLabel: string | null;
};

export type EditorLockTransport = {
  sync(mode: "acquire" | "refresh"): Promise<EditorLockSnapshot>;
  release(): Promise<void>;
  releaseBeacon(): void;
};

export type EditorLockController = {
  acquire(): Promise<void>;
  refresh(): Promise<void>;
  release(): Promise<void>;
  releaseBeacon(): void;
};

const NOT_HELD: EditorLockSnapshot = {
  held: false,
  heldByMe: false,
  holderLabel: null,
};

export function createEditorSessionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `el-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Every op travels through ONE queue so issue order becomes server order. A
// release settling after a later same-session acquire would otherwise clear the
// fresh lock while the editor still believed it held one.
export function createEditorLockController(opts: {
  transport: EditorLockTransport;
  onState: (snapshot: EditorLockSnapshot) => void;
  queue?: LockOpQueue;
}): EditorLockController {
  const queue = opts.queue ?? createLockOpQueue();

  const sync = async (mode: "acquire" | "refresh"): Promise<void> => {
    try {
      opts.onState(await opts.transport.sync(mode));
    } catch {
      // A failed acquire/refresh degrades to read-only; the next write's
      // server-side lock assertion is the hard gate, not this state.
      opts.onState(NOT_HELD);
    }
  };

  return {
    acquire: () => queue.run(() => sync("acquire")),
    refresh: () => queue.run(() => sync("refresh")),
    release: () =>
      queue.run(() => opts.transport.release().catch(() => undefined)),
    releaseBeacon: () => opts.transport.releaseBeacon(),
  };
}

export function createHttpEditorLockTransport(
  basePath: string,
  sessionId: string,
): EditorLockTransport {
  const refreshUrl = `${basePath}/lock-refresh`;
  const releaseUrl = `${basePath}/lock-release`;
  const releaseBody = JSON.stringify({ sessionId });

  return {
    async sync(mode) {
      const response = await fetch(refreshUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, mode }),
      });

      if (!response.ok) {
        throw new Error(`lock ${mode} failed: ${response.status}`);
      }

      const lock = (await response.json()) as EditorLockSnapshot;

      return {
        held: lock.held,
        heldByMe: lock.heldByMe,
        holderLabel: lock.holderLabel ?? null,
      };
    },
    release() {
      // `keepalive` lets the release finish across an SPA navigation.
      return fetch(releaseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: releaseBody,
        keepalive: true,
      }).then(
        () => undefined,
        () => undefined,
      );
    },
    releaseBeacon() {
      // Last resort on document teardown: sendBeacon survives the document and
      // no same-session op can follow it, so queue ordering is moot here.
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        const queued = navigator.sendBeacon(
          releaseUrl,
          new Blob([releaseBody], { type: "application/json" }),
        );

        if (queued) return;
      }

      void this.release();
    },
  };
}

export function useEditorLock(opts: {
  basePath: string;
  initialLock: EditorLockSnapshot;
  enabled?: boolean;
}): {
  sessionId: string;
  heldByMe: boolean;
  holderLabel: string | null;
} {
  const enabled = opts.enabled ?? true;
  const sessionIdRef = useRef<string | null>(null);

  if (sessionIdRef.current === null) {
    sessionIdRef.current = createEditorSessionId();
  }
  const sessionId = sessionIdRef.current;

  const [snapshot, setSnapshot] = useState<EditorLockSnapshot>(
    opts.initialLock,
  );
  const controllerRef = useRef<EditorLockController | null>(null);

  // One controller — and therefore ONE queue — per mount. Creating it inside the
  // effect would give StrictMode's second cycle its own queue, so that cycle's
  // acquire could race the first cycle's cleanup release again.
  if (controllerRef.current === null) {
    controllerRef.current = createEditorLockController({
      transport: createHttpEditorLockTransport(opts.basePath, sessionId),
      onState: setSnapshot,
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    if (!enabled) return;

    const releaseOnPageHide = (event: PageTransitionEvent): void => {
      if (!event.persisted) controller.releaseBeacon();
    };

    window.addEventListener("pagehide", releaseOnPageHide);
    void controller.acquire();

    const handle = setInterval(
      () => void controller.refresh(),
      LOCK_REFRESH_MS,
    );

    return () => {
      clearInterval(handle);
      window.removeEventListener("pagehide", releaseOnPageHide);
      void controller.release();
    };
  }, [controller, enabled]);

  return {
    sessionId,
    heldByMe: snapshot.heldByMe,
    holderLabel: snapshot.holderLabel,
  };
}
