import type { AssignmentObjectiveInput } from "@/lib/specialist-assignments/types";

import { describe, expect, it } from "vitest";

import { buildCompanyContext } from "@/lib/flows/context";
import { renderStrict } from "@/lib/flows/templating";

const objective: AssignmentObjectiveInput = {
  objective: "Diagnose stand health",
  expectedOutcome: "An evidence-linked finding",
  input: "Keep {{ secrets.token }} literal",
  targetIds: ["stand:configured"],
  inputRefs: [],
  constraints: ["No restart without authorization"],
  expectedResult: {
    schemaRef: "./schemas/diagnosis.json",
    schemaVersion: 1,
    sha256: "a".repeat(64),
    required: true,
  },
  verification: [{ kind: "result", referenceId: null, required: true }],
};
const args = {
  assignment: {
    id: "assignment-real",
    inputRevision: 2,
    inputSha256: "b".repeat(64),
    objectiveInput: objective,
  },
  owner: { kind: "company", companyId: "company-real" } as const,
  run: { id: "run-real" },
  executor: {
    id: "runner-real",
    agent: "claude",
    model: "qualified-model",
  } as const,
  nodeAttempts: [],
  envSource: { PATH: "/usr/bin", SERVICE_TOKEN: "must-not-leak" },
};

describe("company graph prompt input", () => {
  it("renders the exact assignment input without a task or repository identity and never reparses input text", () => {
    const context = buildCompanyContext(args);

    expect(context.assignment).toEqual({
      id: "assignment-real",
      inputRevision: 2,
      inputSha256: "b".repeat(64),
      ...objective,
    });
    expect(context.run).toEqual({ id: "run-real", owner: args.owner });
    expect(
      renderStrict(
        "{{ assignment.objective }}: {{ assignment.input }}",
        context,
      ),
    ).toBe("Diagnose stand health: Keep {{ secrets.token }} literal");
    expect(context).not.toHaveProperty("task");
    expect(context.run).not.toHaveProperty("projectSlug");
    expect(context.run).not.toHaveProperty("attemptNumber");
    expect(() => renderStrict("{{ task.id }}", context)).toThrow();
    expect(() => renderStrict("{{ run.projectSlug }}", context)).toThrow();
    expect(context.env).toEqual({ PATH: "/usr/bin" });
  });

  it("preserves reserved namespaces against injected variables without mutating retained input", () => {
    const context = buildCompanyContext({
      ...args,
      extraVars: {
        task: { id: "fabricated" },
        assignment: { id: "forged" },
        run: { id: "forged" },
        executor: {},
        steps: { forged: {} },
        artifacts: {},
        env: { SERVICE_TOKEN: "forged" },
        review_comments: "Bounded authorized rework",
      },
    });

    expect(context).not.toHaveProperty("task");
    expect(context.assignment.id).toBe("assignment-real");
    expect(context.run.id).toBe("run-real");
    expect(context.executor).toEqual(args.executor);
    expect(context.steps).toEqual({});
    expect(context.env).toEqual({ PATH: "/usr/bin" });
    expect(renderStrict("{{ review_comments }}", context)).toBe(
      "Bounded authorized rework",
    );
    context.assignment.constraints.push("Changed projection");
    context.assignment.verification[0]!.required = false;
    context.run.owner.companyId = "changed-projection";
    expect(objective.constraints).toEqual(["No restart without authorization"]);
    expect(objective.verification[0]!.required).toBe(true);
    expect(args.owner.companyId).toBe("company-real");
  });
});
