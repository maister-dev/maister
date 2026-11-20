const workspaceOrder = { none: 0, repo_read: 1, worktree: 2 } as const;
const approvalOrder = { ask: 0, auto_approve: 1 } as const;

export type IsolationAccess = Readonly<{
  workspace: keyof typeof workspaceOrder;
  approval: keyof typeof approvalOrder;
  tools: readonly string[];
  mcps: readonly string[];
}>;

type Decided<T> = Readonly<{
  value: T;
  layer: "ceiling" | "runner" | "workload";
}>;

type IsolationAccessDecision =
  | ({ allowed: true } & {
      [Field in keyof IsolationAccess]: Decided<IsolationAccess[Field]>;
    })
  | {
      allowed: false;
      reason: "access_exceeds_ceiling";
      fields: (keyof IsolationAccess)[];
    };

function narrow<T extends string>(
  order: Readonly<Record<T, number>>,
  ceiling: T,
  request: T | undefined,
  constraint: T | undefined,
): Decided<T> {
  const value = request ?? ceiling;
  if (constraint !== undefined && order[constraint] < order[value]) {
    return { value: constraint, layer: "workload" };
  }
  return { value, layer: request === undefined ? "ceiling" : "runner" };
}

function intersect(
  ceiling: readonly string[],
  request: readonly string[] | undefined,
  constraint: readonly string[] | undefined,
): Decided<readonly string[]> {
  const value = request ?? ceiling;
  const restricted =
    constraint === undefined
      ? value
      : value.filter((id) => constraint.includes(id));
  return {
    value: [...restricted],
    layer:
      restricted.length < value.length
        ? "workload"
        : request === undefined
          ? "ceiling"
          : "runner",
  };
}

/** Resolve already validated policy inputs before any admission side effect. */
export function resolveIsolationAccess(
  ceiling: IsolationAccess,
  runner: Partial<IsolationAccess>,
  workload: Partial<IsolationAccess>,
): IsolationAccessDecision {
  const fields: (keyof IsolationAccess)[] = [];
  if (
    runner.workspace !== undefined &&
    workspaceOrder[runner.workspace] > workspaceOrder[ceiling.workspace]
  )
    fields.push("workspace");
  if (
    runner.approval !== undefined &&
    approvalOrder[runner.approval] > approvalOrder[ceiling.approval]
  )
    fields.push("approval");
  if (runner.tools?.some((id) => !ceiling.tools.includes(id)))
    fields.push("tools");
  if (runner.mcps?.some((id) => !ceiling.mcps.includes(id)))
    fields.push("mcps");
  if (fields.length > 0)
    return { allowed: false, reason: "access_exceeds_ceiling", fields };

  return {
    allowed: true,
    workspace: narrow(
      workspaceOrder,
      ceiling.workspace,
      runner.workspace,
      workload.workspace,
    ),
    approval: narrow(
      approvalOrder,
      ceiling.approval,
      runner.approval,
      workload.approval,
    ),
    tools: intersect(ceiling.tools, runner.tools, workload.tools),
    mcps: intersect(ceiling.mcps, runner.mcps, workload.mcps),
  };
}
