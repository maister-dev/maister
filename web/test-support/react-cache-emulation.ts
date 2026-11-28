// Task 12 (docs/system-analytics/identity-access.md §Per-render memoization) —
// emulates React's `cache()` per-render memoization in Vitest's Node runtime,
// where React's own `cache()` is a pass-through. Uses a positional `Object.is`
// argument trie scoped to `withRender(fn)` via AsyncLocalStorage; calls outside
// any `withRender` pass straight through to the underlying function.
import { AsyncLocalStorage } from "node:async_hooks";

const NEG_ZERO_KEY = Symbol("react-cache-neg-zero");

type CacheEntry =
  { kind: "value"; value: unknown } | { kind: "error"; error: unknown };

type TrieNode = {
  children: Map<unknown, TrieNode>;
  entry?: CacheEntry;
};

function createTrieNode(): TrieNode {
  return { children: new Map() };
}

function mapKeyFor(arg: unknown): unknown {
  // Map uses SameValueZero where -0 === +0; Object.is distinguishes them.
  return Object.is(arg, -0) ? NEG_ZERO_KEY : arg;
}

export function createReactCacheEmulation() {
  const storage = new AsyncLocalStorage<Map<Function, TrieNode>>();

  // FIXME(any): mirrors React's own `cache` signature, typed over any function.
  function cache<T extends (...args: any[]) => any>(fn: T): T {
    const wrapped = function (...args: Parameters<T>): ReturnType<T> {
      const renderMap = storage.getStore();

      if (!renderMap) {
        return fn(...args);
      }

      let node: TrieNode = renderMap.get(fn) ?? createTrieNode();

      if (!renderMap.has(fn)) {
        renderMap.set(fn, node);
      }

      for (const arg of args) {
        const key = mapKeyFor(arg);
        let child: TrieNode | undefined = node.children.get(key);

        if (!child) {
          child = createTrieNode();
          node.children.set(key, child);
        }
        node = child;
      }

      if (node.entry) {
        if (node.entry.kind === "error") throw node.entry.error;

        return node.entry.value as ReturnType<T>;
      }

      try {
        const value = fn(...args);

        node.entry = { kind: "value", value };

        return value;
      } catch (error) {
        node.entry = { kind: "error", error };
        throw error;
      }
    };

    return wrapped as T;
  }

  function withRender<T>(fn: () => T): T {
    return storage.run(new Map(), fn);
  }

  return { cache, withRender };
}

const defaultEmulation = createReactCacheEmulation();

export const emulatedReactCache = defaultEmulation.cache;
export const withEmulatedRender = defaultEmulation.withRender;
