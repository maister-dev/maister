"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

// Non-ICU `$holder` interpolation, shared by both editors' read-only banners.
// The function-form replacement inserts the raw value literally — a plain string
// `.replace` would interpret `$&`, `` $` ``, `$'`, and `$1` in a user-controlled
// holder label (e.g. a user literally named "$&").
export function formatHolderLabel(
  template: string,
  holderLabel: string,
): string {
  return template.replace("$holder", () => holderLabel);
}

export function createEditorSessionId(): string {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    // `randomUUID` is secure-context-only; `getRandomValues` is NOT. A self-host
    // served over plain HTTP on a LAN address would otherwise fall through to the
    // predictable `Date.now()`/`Math.random()` id, which a same-project peer can
    // reconstruct to steal the (server-user-bound) session. Prefer real entropy.
    if (typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));

      return `el-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
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
  // True only once a server round-trip confirmed this session holds the lock —
  // distinct from `heldByMe`, which starts from the page's optimistic snapshot.
  // Gate anything that must not run on an unconfirmed lock on this.
  confirmed: boolean;
  // Explicit "done editing" release through the same queue as acquire/refresh.
  release: () => void;
  // A write that came back CONFLICT proves the lock is gone: flip to read-only
  // now instead of waiting for the next heartbeat to notice.
  markLost: () => void;
  // User-initiated recovery after a takeover. Re-attempts acquire once (through
  // the queue): succeeds if the lock has since freed, stays read-only otherwise.
  // In-place, so unsaved edits survive — unlike a full reload.
  retry: () => void;
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
  const [confirmed, setConfirmed] = useState(false);
  const controllerRef = useRef<{
    basePath: string;
    controller: EditorLockController;
  } | null>(null);
  // Monotonic controller id. A superseded controller (basePath re-key, or a
  // StrictMode acquire that settles after its cleanup) still holds the closed-
  // over `generation`; if it no longer matches the live ref, its late `onState`
  // is dropped instead of clobbering the current controller's state.
  const generationRef = useRef(0);

  // One controller — and therefore ONE queue — per mount. Creating it inside the
  // effect would give StrictMode's second cycle its own queue, so that cycle's
  // acquire could race the first cycle's cleanup release again. A changed
  // basePath targets a different row, so re-keying the queue there is safe.
  if (
    controllerRef.current === null ||
    controllerRef.current.basePath !== opts.basePath
  ) {
    generationRef.current += 1;
    const generation = generationRef.current;

    controllerRef.current = {
      basePath: opts.basePath,
      controller: createEditorLockController({
        transport: createHttpEditorLockTransport(opts.basePath, sessionId),
        onState: (next) => {
          if (generationRef.current !== generation) return;

          setSnapshot(next);
          // A failed sync reports NOT_HELD, so this also clears confirmation.
          setConfirmed(next.heldByMe);
        },
      }),
    };
  }
  const controller = controllerRef.current.controller;

  useEffect(() => {
    if (!enabled) return;

    setConfirmed(false);

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

  const release = useCallback((): void => {
    void controller.release();
  }, [controller]);

  const markLost = useCallback((): void => {
    setSnapshot((prev) => ({ ...prev, heldByMe: false }));
  }, []);

  const retry = useCallback((): void => {
    void controller.acquire();
  }, [controller]);

  return {
    sessionId,
    heldByMe: snapshot.heldByMe,
    holderLabel: snapshot.holderLabel,
    confirmed,
    release,
    markLost,
    retry,
  };
}
