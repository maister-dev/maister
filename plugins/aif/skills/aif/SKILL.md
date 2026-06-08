# AIF Flow Skill

Use this skill when a MAIster Flow package needs to run the AI Factory delivery
loop inside a project workspace.

## Workflow

1. Explore the task and constraints.
2. Write or update the implementation plan.
3. Implement the plan in a TDD manner.
4. Fix implementation or verification issues.
5. Hand off to human review.

## Package Rules

- Treat this package as portable across MAIster installations.
- Keep setup scripts inert until the MAIster Flow package lifecycle has recorded
  trust and runs setup.
- Prefer project-scoped rules and skills over global assumptions.
