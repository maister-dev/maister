// MEMO-04 (docs/system-analytics/identity-access.md §Per-render memoization) —
// verifies `getSessionUser()` and Auth.js `jwt` callback share one per-render
// `users` query via `loadUserCached`, while re-reading across renders and on
// every call outside an RSC render.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectSpy, userRow, capturedCallbacks } = vi.hoisted(() => ({
  selectSpy: vi.fn(),
  userRow: {
    id: "user-1",
    role: "member" as const,
    accountStatus: "active" as const,
    email: "member@example.test",
    name: "Member",
    mustChangePassword: false,
  },
  capturedCallbacks: {
    jwt: null as
      | ((args: {
          token: Record<string, unknown>;
          user?: unknown;
        }) => Promise<Record<string, unknown> | null>)
      | null,
  },
}));

vi.mock("react", async (importActual) => {
  const { emulatedReactCache } =
    await import("@/test-support/react-cache-emulation");

  return {
    ...(await importActual<typeof import("react")>()),
    cache: emulatedReactCache,
  };
});

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: (...args: unknown[]) => {
      selectSpy(...args);

      return {
        from: () => ({
          where: async () => [userRow],
        }),
      };
    },
  }),
}));

vi.mock("next-auth", () => ({
  default: (
    configFn: () => { callbacks?: { jwt?: typeof capturedCallbacks.jwt } },
  ) => {
    const config = configFn();

    capturedCallbacks.jwt = config.callbacks?.jwt ?? null;

    return {
      handlers: {},
      auth: async () => {
        const token = capturedCallbacks.jwt
          ? await capturedCallbacks.jwt({ token: { id: userRow.id } })
          : { id: userRow.id };

        return token ? { user: { id: token.id } } : null;
      },
      signIn: vi.fn(),
      signOut: vi.fn(),
    };
  },
}));

vi.mock("@auth/drizzle-adapter", () => ({
  DrizzleAdapter: vi.fn(() => ({})),
}));

vi.mock("@/lib/users", () => ({
  verifyCredentialAccount: vi.fn(),
}));

import { withEmulatedRender } from "@/test-support/react-cache-emulation";
import { getSessionUser, loadUserCached } from "@/lib/authz";

describe("session user per-render memoization (MEMO-04)", () => {
  beforeEach(() => {
    selectSpy.mockClear();
  });

  it("MEMO-04 reads the users row once per render across two getSessionUser() calls and the jwt callback", async () => {
    const [first, second, direct] = await withEmulatedRender(async () => {
      const a = await getSessionUser();
      const b = await getSessionUser();
      const c = await loadUserCached(userRow.id);

      return [a, b, c] as const;
    });

    expect(first?.id).toBe(userRow.id);
    expect(second?.id).toBe(userRow.id);
    expect(direct?.id).toBe(userRow.id);
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it("MEMO-04 re-reads across two separate renders", async () => {
    await withEmulatedRender(() => getSessionUser());
    await withEmulatedRender(() => getSessionUser());

    expect(selectSpy).toHaveBeenCalledTimes(2);
  });

  it("MEMO-04 re-reads on every call outside a render", async () => {
    await loadUserCached(userRow.id);
    await loadUserCached(userRow.id);

    expect(selectSpy).toHaveBeenCalledTimes(2);
  });
});
