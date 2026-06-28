import { describe, expect, it, vi } from "vitest";

import { renderStrict } from "@/lib/flows/templating";
import { isMaisterError, MaisterError } from "@/lib/errors";

const baseContext = {
  task: { id: "t1", title: "Title", prompt: "Hello", attemptNumber: 1 },
  run: { id: "r1", attemptNumber: 1, projectSlug: "demo" },
  executor: {
    id: "e1",
    agent: "claude",
    model: "claude-sonnet-4-6",
  },
  steps: {
    plan: { output: "plan stdout", vars: {}, exitCode: 0 },
  },
  env: { PATH: "/usr/bin" },
};

describe("renderStrict — Mustache strict resolver", () => {
  it("resolves task.prompt to its value", () => {
    expect(renderStrict("{{ task.prompt }}", baseContext)).toBe("Hello");
  });

  it("resolves steps.<id>.output from a prior step", () => {
    expect(renderStrict("{{ steps.plan.output }}", baseContext)).toBe(
      "plan stdout",
    );
  });

  it("throws MaisterError(CONFIG) on undefined leaf path", () => {
    try {
      renderStrict("X {{ task.nonexistent }} Y", baseContext);
      throw new Error("expected throw");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      const e = err as MaisterError;

      expect(e.code).toBe("CONFIG");
      expect(e.message).toMatch(/task\.nonexistent/);
    }
  });

  it("throws on undefined deep leaf inside steps.*", () => {
    try {
      renderStrict("{{ steps.never.vars.x }}", baseContext);
      throw new Error("expected throw");
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as MaisterError).code).toBe("CONFIG");
      expect((err as MaisterError).message).toMatch(/steps\.never/);
    }
  });

  it("does not HTML-escape — passes <script> through raw", () => {
    const ctx = {
      ...baseContext,
      task: { ...baseContext.task, prompt: "<script>alert(1)</script>" },
    };

    expect(renderStrict("{{ task.prompt }}", ctx)).toBe(
      "<script>alert(1)</script>",
    );
  });

  it("resolves nested dotted paths (executor.model)", () => {
    expect(renderStrict("{{ executor.model }}", baseContext)).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("calls traceLog.debug once per resolved leaf", () => {
    const traceLog = { debug: vi.fn() } as unknown as Parameters<
      typeof renderStrict
    >[2] extends infer P
      ? NonNullable<P> extends { traceLog?: infer T }
        ? T
        : never
      : never;

    renderStrict("{{ task.prompt }} {{ executor.model }}", baseContext, {
      traceLog: traceLog as never,
    });
    const debug = (traceLog as unknown as { debug: ReturnType<typeof vi.fn> })
      .debug;

    expect(debug.mock.calls.length).toBeGreaterThanOrEqual(2);
    const paths = debug.mock.calls
      .map((c) => (c[0] as { path?: string }).path)
      .filter(Boolean);

    expect(paths).toEqual(
      expect.arrayContaining(["task.prompt", "executor.model"]),
    );
  });

  it("truncates traceLog string values to 200 chars with ellipsis", () => {
    const long = "x".repeat(500);
    const ctx = { ...baseContext, task: { ...baseContext.task, prompt: long } };
    const traceLog = { debug: vi.fn() };

    renderStrict("{{ task.prompt }}", ctx, {
      traceLog: traceLog as never,
    });

    const promptCall = traceLog.debug.mock.calls.find(
      (c) => (c[0] as { path?: string }).path === "task.prompt",
    );

    expect(promptCall).toBeDefined();
    const value = (promptCall![0] as { value: string }).value;

    expect(value.length).toBe(201);
    expect(value.endsWith("…")).toBe(true);
  });

  it("empty template returns empty string", () => {
    expect(renderStrict("", baseContext)).toBe("");
  });

  it("env.PATH resolves through env subcontext", () => {
    expect(renderStrict("PATH={{ env.PATH }}", baseContext)).toBe(
      "PATH=/usr/bin",
    );
  });

  it("resolves guarded default operator paths to present values", () => {
    expect(renderStrict("{{ executor.model ?? '' }}", baseContext)).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("resolves guarded default operator paths to empty literals when absent", () => {
    expect(renderStrict("{{ executor.router ?? '' }}", baseContext)).toBe("");
  });

  it("resolves guarded nested paths to double-quoted literals when absent", () => {
    expect(renderStrict('{{ steps.plan.vars.maybe ?? "n/a" }}', baseContext)).toBe(
      "n/a",
    );
  });

  it("resolves guarded nested paths to values when present", () => {
    const ctx = {
      ...baseContext,
      steps: {
        ...baseContext.steps,
        plan: {
          ...baseContext.steps.plan,
          vars: { maybe: "structured verdict" },
        },
      },
    };

    expect(renderStrict('{{ steps.plan.vars.maybe ?? "n/a" }}', ctx)).toBe(
      "structured verdict",
    );
  });

  it("keeps bare paths strict when guarded paths use defaults", () => {
    expect(() => renderStrict("{{ executor.router }}", baseContext)).toThrow(
      MaisterError,
    );
  });

  it("parses single-quote, double-quote, and empty guarded literals", () => {
    expect(renderStrict("{{ executor.router ?? 'single' }}", baseContext)).toBe(
      "single",
    );
    expect(renderStrict('{{ executor.router ?? "double" }}', baseContext)).toBe(
      "double",
    );
    expect(renderStrict('{{ executor.router ?? "" }}', baseContext)).toBe("");
  });

  it("renders templates that mix bare required and guarded optional paths", () => {
    expect(
      renderStrict(
        "{{ task.prompt }} / {{ executor.router ?? 'no router' }}",
        baseContext,
      ),
    ).toBe("Hello / no router");
  });

  it("inserts guarded literals containing braces without re-parsing them", () => {
    expect(
      renderStrict("{{ executor.router ?? '{{ task.prompt }}' }}", baseContext),
    ).toBe("{{ task.prompt }}");
  });
});
