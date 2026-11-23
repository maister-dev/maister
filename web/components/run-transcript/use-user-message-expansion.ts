"use client";

import { useSyncExternalStore } from "react";

const parameter = "transcript-open";
const event = "maister:transcript-disclosure";

function key(messageId: string, section: string): string {
  return JSON.stringify([1, messageId, section]);
}

export function readDisclosureKeys(search: string): ReadonlySet<string> {
  const keys = new Set<string>();

  for (const raw of new URLSearchParams(search).getAll(parameter)) {
    let value: unknown;

    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === 1 &&
      typeof value[1] === "string" &&
      value[1].length > 0 &&
      typeof value[2] === "string" &&
      /^(message|skills:(0|[1-9]\d*))$/.test(value[2])
    )
      keys.add(key(value[1], value[2]));
  }

  return keys;
}

export function writeDisclosure(
  href: string,
  messageId: string,
  section: string,
  open: boolean,
): URL {
  const url = new URL(href);
  const keys = new Set(readDisclosureKeys(url.search));
  const entry = key(messageId, section);

  if (open) keys.add(entry);
  else keys.delete(entry);
  url.searchParams.delete(parameter);
  for (const value of [...keys].sort())
    url.searchParams.append(parameter, value);

  return url;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  window.addEventListener(event, callback);

  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(event, callback);
  };
}

function snapshot(): string {
  return window.location.search;
}

function serverSnapshot(): string {
  return "";
}

export function useUserMessageExpansion(
  messageId: string,
  section: string,
): readonly [boolean, (open: boolean) => void] {
  const search = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const open = readDisclosureKeys(search).has(key(messageId, section));

  function setOpen(next: boolean): void {
    const current = readDisclosureKeys(window.location.search).has(
      key(messageId, section),
    );

    if (current === next) return;
    const url = writeDisclosure(window.location.href, messageId, section, next);

    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new Event(event));
  }

  return [open, setOpen];
}
