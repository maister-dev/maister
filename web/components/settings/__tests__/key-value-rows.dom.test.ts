// @vitest-environment jsdom

// ADR-179 (D25): the shared key/value rows control. Behaviour only — a callback
// fired, a record shaped, a warning shown — never "renders without crashing".
//
// The runner modal's own suite is the other half of this contract: it passes
// UNCHANGED through the extraction, which is what proves the swap preserved
// behaviour rather than merely compiling.

import type { KeyValueRow } from "@/components/settings/key-value-rows";
import type { Root } from "react-dom/client";

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  KeyValueRows,
  duplicateKeyIds,
  recordFromRows,
  rowsFromRecord,
} from "@/components/settings/key-value-rows";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS = {
  title: "Environment",
  hint: "value or env:NAME",
  key: "Env key",
  value: "Value",
  add: "Add env",
  remove: "Remove env",
};

const roots: Root[] = [];
let lastRows: KeyValueRow[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

type HostProps = Omit<
  Parameters<typeof KeyValueRows>[0],
  "rows" | "onChange" | "labels"
> & { initial?: Record<string, string>; labels?: typeof LABELS };

// Controlled host mirroring a real consumer: the component lifts rows up and
// they flow back down as props.
function Host(props: HostProps) {
  const [rows, setRows] = useState<KeyValueRow[]>(() =>
    rowsFromRecord(props.initial),
  );

  lastRows = rows;

  return createElement(KeyValueRows, {
    ...props,
    labels: props.labels ?? LABELS,
    rows,
    onChange: (next: KeyValueRow[]) => {
      lastRows = next;
      setRows(next);
    },
  });
}

function mount(props: HostProps = {}): HTMLElement {
  const node = document.createElement("div");

  document.body.append(node);
  const root = createRoot(node);

  roots.push(root);
  act(() => root.render(createElement(Host, props)));

  return node;
}

function inputs(node: HTMLElement, label: string): HTMLInputElement[] {
  return [
    ...node.querySelectorAll<HTMLInputElement>(`[aria-label="${label}"]`),
  ];
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;

  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("KeyValueRows", () => {
  it("renders one labelled key/value pair per record entry", () => {
    const node = mount({ initial: { A: "1", B: "env:B_REF" } });

    expect(inputs(node, LABELS.key).map((i) => i.value)).toEqual(["A", "B"]);
    expect(inputs(node, LABELS.value).map((i) => i.value)).toEqual([
      "1",
      "env:B_REF",
    ]);
  });

  it("add appends an EMPTY row without touching the existing ones", () => {
    const node = mount({ initial: { A: "1" } });

    click(
      [...node.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(LABELS.add),
      )!,
    );

    expect(lastRows).toHaveLength(2);
    expect(lastRows[1]).toMatchObject({ key: "", value: "" });
    expect(lastRows[0]).toMatchObject({ key: "A", value: "1" });
  });

  it("remove deletes by row id, not by index", () => {
    const node = mount({ initial: { A: "1", B: "2", C: "3" } });

    click(node.querySelectorAll(`[aria-label="${LABELS.remove}"]`)[1]!);

    expect(lastRows.map((r) => r.key)).toEqual(["A", "C"]);
  });

  it("an edit reports the FULL array, not a delta", () => {
    const node = mount({ initial: { A: "1", B: "2" } });

    type(inputs(node, LABELS.value)[0]!, "changed");

    expect(lastRows).toHaveLength(2);
    expect(lastRows[0]).toMatchObject({ key: "A", value: "changed" });
    expect(lastRows[1]).toMatchObject({ key: "B", value: "2" });
  });

  it("renders a datalist only when keySuggestions are given", () => {
    expect(mount({ initial: { A: "1" } }).querySelector("datalist")).toBeNull();

    const node = mount({
      initial: { A: "1" },
      keySuggestions: ["SLOT_ONE", "SLOT_TWO"],
    });
    const list = node.querySelector("datalist");

    expect([...list!.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "SLOT_ONE",
      "SLOT_TWO",
    ]);
    expect(inputs(node, LABELS.key)[0]!.getAttribute("list")).toBe(list!.id);
  });

  it("warningFor renders inline WITHOUT marking the row invalid", () => {
    // The secret guard is a warning, never a refusal: a warned row must stay
    // submittable, so it must not set aria-invalid.
    const node = mount({
      initial: { GITHUB_TOKEN: "ghp_literal" },
      warningFor: () => "looks like a credential",
    });

    expect(node.querySelector('[role="note"]')?.textContent).toBe(
      "looks like a credential",
    );
    expect(
      inputs(node, LABELS.key)[0]!.getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("errorFor marks the row invalid and suppresses the warning", () => {
    const node = mount({
      initial: { GH: "env:1BAD" },
      errorFor: () => "must be env:NAME",
      warningFor: () => "looks like a credential",
    });

    expect(inputs(node, LABELS.key)[0]!.getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(node.textContent).toContain("must be env:NAME");
    expect(node.querySelector('[role="note"]')).toBeNull();
  });

  it("disabled disables every control", () => {
    const node = mount({ initial: { A: "1" }, disabled: true });

    for (const el of node.querySelectorAll("input, button")) {
      expect((el as HTMLInputElement).disabled).toBe(true);
    }
  });
});

describe("rowsFromRecord / recordFromRows round-trip", () => {
  it("round-trips a record", () => {
    const record = { A: "1", B: "env:B_REF" };

    expect(recordFromRows(rowsFromRecord(record))).toEqual(record);
  });

  it("drops a fully empty row and keeps a key-only row as an empty literal", () => {
    const rows: KeyValueRow[] = [
      { id: "1", key: "A", value: "1" },
      { id: "2", key: "", value: "" },
      { id: "3", key: "FLAG", value: "" },
    ];

    expect(recordFromRows(rows)).toEqual({ A: "1", FLAG: "" });
  });

  it("returns undefined when every row is empty — a sparse payload", () => {
    expect(recordFromRows([{ id: "1", key: "", value: "" }])).toBeUndefined();
    expect(recordFromRows([])).toBeUndefined();
  });

  it("trims keys so a stray space cannot mint a second slot", () => {
    expect(recordFromRows([{ id: "1", key: "  A  ", value: "1" }])).toEqual({
      A: "1",
    });
  });
});

describe("duplicateKeyIds", () => {
  it("flags EVERY row of a colliding key, so the author sees the pair", () => {
    const ids = duplicateKeyIds([
      { id: "1", key: "A", value: "1" },
      { id: "2", key: "A", value: "2" },
      { id: "3", key: "B", value: "3" },
    ]);

    expect([...ids].sort()).toEqual(["1", "2"]);
  });

  it("ignores blank keys — a fresh row is not a duplicate of another fresh row", () => {
    expect(
      duplicateKeyIds([
        { id: "1", key: "", value: "" },
        { id: "2", key: "", value: "" },
      ]).size,
    ).toBe(0);
  });
});
