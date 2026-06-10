import { describe, expect, it, vi } from "vitest";

import {
  compareThreadReplies,
  compareThreadRoots,
} from "@/lib/review-comments/service";

// service.ts consumes PENDING_HITL_RUN_STATUS from @/lib/services/hitl, whose
// module graph pulls authz (NextAuth), supervisor-client, and the flow runner.
// Mock those boundaries so the pure comparators are testable in the unit env.
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/supervisor-client", () => ({
  deliverPermission: vi.fn(),
  cancelPermission: vi.fn(),
}));
vi.mock("@/lib/flows/runner", () => ({ runFlow: vi.fn() }));
vi.mock("@/lib/authz", () => ({ requireProjectAction: vi.fn() }));

function root(over: {
  filePath?: string;
  line?: number;
  side?: "old" | "new";
  createdAt?: Date;
  id?: string;
}): {
  filePath: string | null;
  line: number | null;
  side: "old" | "new" | null;
  createdAt: Date;
  id: string;
} {
  return {
    filePath: over.filePath ?? "a.ts",
    line: over.line ?? 1,
    side: over.side ?? "new",
    createdAt: over.createdAt ?? new Date(0),
    id: over.id ?? "id-1",
  };
}

describe("compareThreadRoots — frozen (file_path, line, side old<new, created_at, id) order", () => {
  it("sorts by file_path lexicographically first", () => {
    expect(
      compareThreadRoots(
        root({ filePath: "a.ts" }),
        root({ filePath: "b.ts" }),
      ),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(
        root({ filePath: "b.ts" }),
        root({ filePath: "a.ts" }),
      ),
    ).toBeGreaterThan(0);
  });

  it("sorts by line numerically, not lexicographically", () => {
    expect(
      compareThreadRoots(root({ line: 9 }), root({ line: 10 })),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(root({ line: 10 }), root({ line: 9 })),
    ).toBeGreaterThan(0);
  });

  it("orders side old before new at the same file/line", () => {
    expect(
      compareThreadRoots(root({ side: "old" }), root({ side: "new" })),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(root({ side: "new" }), root({ side: "old" })),
    ).toBeGreaterThan(0);
  });

  it("breaks anchor ties by created_at then id", () => {
    expect(
      compareThreadRoots(
        root({ createdAt: new Date(1) }),
        root({ createdAt: new Date(2) }),
      ),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(root({ id: "id-a" }), root({ id: "id-b" })),
    ).toBeLessThan(0);
    expect(compareThreadRoots(root({}), root({}))).toBe(0);
  });

  it("file_path outranks line, line outranks side", () => {
    expect(
      compareThreadRoots(
        root({ filePath: "a.ts", line: 100 }),
        root({ filePath: "b.ts", line: 1 }),
      ),
    ).toBeLessThan(0);
    expect(
      compareThreadRoots(
        root({ line: 1, side: "new" }),
        root({ line: 2, side: "old" }),
      ),
    ).toBeLessThan(0);
  });
});

describe("compareThreadReplies — (created_at, id) order", () => {
  it("sorts by created_at ascending", () => {
    expect(
      compareThreadReplies(
        { createdAt: new Date(1), id: "z" },
        { createdAt: new Date(2), id: "a" },
      ),
    ).toBeLessThan(0);
  });

  it("breaks created_at ties by id ascending", () => {
    expect(
      compareThreadReplies(
        { createdAt: new Date(1), id: "a" },
        { createdAt: new Date(1), id: "b" },
      ),
    ).toBeLessThan(0);
    expect(
      compareThreadReplies(
        { createdAt: new Date(1), id: "b" },
        { createdAt: new Date(1), id: "a" },
      ),
    ).toBeGreaterThan(0);
  });
});
