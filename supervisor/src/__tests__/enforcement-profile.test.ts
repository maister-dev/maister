import { describe, expect, it } from "vitest";

import {
  SessionEnforcementProfileSchema,
  StartSessionRequestSchema,
} from "../types";

// ADR-130 T2.1: the wire acceptor for the derived capability-enforcement set.
const validRequest = {
  runId: "run-1",
  projectSlug: "my-project",
  worktreePath: "/repos/x",
  stepId: "plan",
  executor: { agent: "claude", model: "claude-sonnet-4-6" },
} as const;

const validProfile = {
  tools: { allow: ["Read", "Edit", "mcp__github__create_issue"] },
  mcps: { allowServers: ["github"] },
  enforcedClasses: ["tools", "mcps"],
  escalationThreshold: 3,
} as const;

describe("SessionEnforcementProfileSchema", () => {
  it("accepts a fully-populated profile", () => {
    expect(SessionEnforcementProfileSchema.safeParse(validProfile).success).toBe(
      true,
    );
  });

  it("accepts a tools-only profile (mcps absent)", () => {
    expect(
      SessionEnforcementProfileSchema.safeParse({
        tools: { allow: ["Bash"] },
        enforcedClasses: ["tools"],
        escalationThreshold: 3,
      }).success,
    ).toBe(true);
  });

  it("accepts an mcps allow-set that is empty (deny-all-MCP is valid)", () => {
    expect(
      SessionEnforcementProfileSchema.safeParse({
        mcps: { allowServers: [] },
        enforcedClasses: ["mcps"],
        escalationThreshold: 3,
      }).success,
    ).toBe(true);
  });

  it("rejects an empty tools allow-list (never enforce-nothing)", () => {
    expect(
      SessionEnforcementProfileSchema.safeParse({
        tools: { allow: [] },
        enforcedClasses: ["tools"],
        escalationThreshold: 3,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty enforcedClasses list", () => {
    expect(
      SessionEnforcementProfileSchema.safeParse({
        tools: { allow: ["Bash"] },
        enforcedClasses: [],
        escalationThreshold: 3,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown enforced class", () => {
    expect(
      SessionEnforcementProfileSchema.safeParse({
        enforcedClasses: ["skills"],
        escalationThreshold: 3,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-positive escalationThreshold", () => {
    expect(
      SessionEnforcementProfileSchema.safeParse({
        tools: { allow: ["Bash"] },
        enforcedClasses: ["tools"],
        escalationThreshold: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown key (strict)", () => {
    expect(
      SessionEnforcementProfileSchema.safeParse({
        ...validProfile,
        deniedTools: ["rm"],
      }).success,
    ).toBe(false);
  });

  it("requires enforcedClasses and escalationThreshold", () => {
    expect(
      SessionEnforcementProfileSchema.safeParse({
        tools: { allow: ["Bash"] },
      }).success,
    ).toBe(false);
  });
});

describe("StartSessionRequestSchema enforcementProfile", () => {
  it("accepts a request carrying a valid enforcementProfile", () => {
    expect(
      StartSessionRequestSchema.safeParse({
        ...validRequest,
        enforcementProfile: validProfile,
      }).success,
    ).toBe(true);
  });

  it("accepts a request with no enforcementProfile (optional)", () => {
    expect(StartSessionRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("rejects a request whose enforcementProfile is malformed", () => {
    expect(
      StartSessionRequestSchema.safeParse({
        ...validRequest,
        enforcementProfile: { enforcedClasses: [], escalationThreshold: 3 },
      }).success,
    ).toBe(false);
  });
});
