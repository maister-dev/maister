import type {
  BacklogCard,
  BoardAgent,
  BoardData,
  FlightCard,
} from "@/lib/queries/board";
import type { TaskPriority } from "@/lib/tasks/criticality";

export const BOARD_FILTER_QUERY_KEYS = {
  flow: "board_flow",
  agent: "board_agent",
  priority: "board_priority",
  touched: "board_touched",
} as const;

export const BOARD_FILTER_NONE = "__none__";

export type BoardTouchedFilter = "1d" | "7d" | "30d";

export interface BoardFilters {
  flow: string;
  agent: string;
  priority: "" | TaskPriority;
  touched: "" | BoardTouchedFilter;
}

export interface BoardFilterOptions {
  flows: string[];
  agents: BoardAgent[];
  hasFlowless: boolean;
  hasAgentless: boolean;
}

type FilterableCard = BacklogCard | FlightCard;

const TASK_PRIORITIES = new Set<TaskPriority>([
  "low",
  "normal",
  "high",
  "urgent",
]);
const TOUCHED_FILTERS = new Set<BoardTouchedFilter>(["1d", "7d", "30d"]);

function cards(data: BoardData): FilterableCard[] {
  return Object.values(data.columns).flatMap((column) => [
    ...column.backlog,
    ...column.flight,
  ]);
}

function cardAgent(card: FilterableCard): BoardAgent | null {
  return card.agent ?? null;
}

export function getBoardFilterOptions(data: BoardData): BoardFilterOptions {
  const allCards = cards(data);
  const flows = new Set<string>();
  const agents = new Set<BoardAgent>();
  let hasFlowless = false;
  let hasAgentless = false;

  for (const card of allCards) {
    if (card.flowRef) flows.add(card.flowRef);
    else hasFlowless = true;

    const agent = cardAgent(card);

    if (agent) agents.add(agent);
    else hasAgentless = true;
  }

  return {
    flows: [...flows].sort((a, b) => a.localeCompare(b)),
    agents: [...agents].sort((a, b) => a.localeCompare(b)),
    hasFlowless,
    hasAgentless,
  };
}

export function normalizeBoardFilters(
  input: Partial<Record<keyof BoardFilters, string | undefined>>,
  options: BoardFilterOptions,
): BoardFilters {
  const flow =
    input.flow === BOARD_FILTER_NONE
      ? options.hasFlowless
        ? BOARD_FILTER_NONE
        : ""
      : options.flows.includes(input.flow ?? "")
        ? (input.flow ?? "")
        : "";
  const agent =
    input.agent === BOARD_FILTER_NONE
      ? options.hasAgentless
        ? BOARD_FILTER_NONE
        : ""
      : options.agents.includes((input.agent ?? "") as BoardAgent)
        ? (input.agent ?? "")
        : "";
  const priority = TASK_PRIORITIES.has(input.priority as TaskPriority)
    ? (input.priority as TaskPriority)
    : "";
  const touched = TOUCHED_FILTERS.has(input.touched as BoardTouchedFilter)
    ? (input.touched as BoardTouchedFilter)
    : "";

  return { flow, agent, priority, touched };
}

function touchedAfter(value: BoardTouchedFilter, now: Date): number {
  const days = Number.parseInt(value, 10);

  return now.getTime() - days * 24 * 60 * 60 * 1000;
}

function matchesCard(
  card: FilterableCard,
  filters: BoardFilters,
  now: Date,
): boolean {
  if (
    filters.flow &&
    (filters.flow === BOARD_FILTER_NONE
      ? card.flowRef !== null
      : card.flowRef !== filters.flow)
  ) {
    return false;
  }

  const agent = cardAgent(card);

  if (
    filters.agent &&
    (filters.agent === BOARD_FILTER_NONE
      ? agent !== null
      : agent !== filters.agent)
  ) {
    return false;
  }

  if (filters.priority && card.taskPriority !== filters.priority) return false;

  if (filters.touched) {
    const touchedAt = card.touchedAt
      ? Date.parse(card.touchedAt)
      : Number.NEGATIVE_INFINITY;

    if (touchedAt < touchedAfter(filters.touched, now)) return false;
  }

  return true;
}

export function filterBoardData(
  data: BoardData,
  filters: BoardFilters,
  now = new Date(),
): BoardData {
  const columns = Object.fromEntries(
    Object.entries(data.columns).map(([key, column]) => {
      const backlog = column.backlog.filter((card) =>
        matchesCard(card, filters, now),
      );
      const flight = column.flight.filter((card) =>
        matchesCard(card, filters, now),
      );

      return [
        key,
        {
          ...column,
          backlog,
          flight,
          total: backlog.length + flight.length,
        },
      ];
    }),
  ) as BoardData["columns"];
  const totalTasks = Object.values(columns).reduce(
    (total, column) => total + column.total,
    0,
  );

  return {
    ...data,
    columns,
    totalTasks,
    inProd: columns.InProduction.total,
    backlog: columns.Backlog.total,
  };
}

export function hasActiveBoardFilters(filters: BoardFilters): boolean {
  return Object.values(filters).some(Boolean);
}
