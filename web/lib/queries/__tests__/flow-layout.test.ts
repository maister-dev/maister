import { beforeEach, describe, expect, it } from "vitest";

import { flowGraphLayouts as layoutsTable } from "@/lib/db/schema";
import { getFlowLayout } from "@/lib/queries/flow-layout";

type Row = Record<string, unknown>;

const dbState: { rows: Row[] } = { rows: [] };

function tableOf(t: unknown): "flow_graph_layouts" {
  if (t === layoutsTable) return "flow_graph_layouts";
  throw new Error("unknown table");
}

const selectChain = () => ({
  from: (table: unknown) => {
    tableOf(table);

    return {
      where: async () => dbState.rows,
    };
  },
});

// FIXME(any): minimal drizzle-like fake DB for the query under test.
const fakeDb = { select: selectChain } as any;

beforeEach(() => {
  dbState.rows = [];
});

describe("getFlowLayout", () => {
  it("returns a nodeId -> {x,y} map for the flow's layout rows", async () => {
    dbState.rows = [
      { nodeId: "plan", x: 10, y: 20 },
      { nodeId: "review", x: 30.5, y: -5 },
    ];

    const map = await getFlowLayout("flow-1", fakeDb);

    expect(map).toEqual({
      plan: { x: 10, y: 20 },
      review: { x: 30.5, y: -5 },
    });
  });

  it("returns an empty object when the flow has no layout rows", async () => {
    dbState.rows = [];

    const map = await getFlowLayout("flow-empty", fakeDb);

    expect(map).toEqual({});
  });
});
