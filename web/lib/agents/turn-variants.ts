import type { AgentTurn } from "@/lib/db/schema";

// ADR-182 D-F4: which turn variants OWN a prompt turn. A steer rides inside
// its parent's prompt, so every reader that means "the run's active turn" —
// the continuation worker, the session driver, the permission sources, the
// message claim's prior-turn check, the idle resume source — selects through
// this list and never mistakes a steer for the parent. The map is exhaustive
// over the variant union: a new variant fails to compile until it is
// classified here.
const OWNS_A_TURN: Readonly<Record<AgentTurn["variant"], boolean>> = {
  initial: true,
  resume: true,
  rework: true,
  live_message: true,
  persistent_message: true,
  consensus_draft: true,
  steer: false,
};

export const OWNED_TURN_VARIANTS: readonly AgentTurn["variant"][] = (
  Object.keys(OWNS_A_TURN) as AgentTurn["variant"][]
).filter((variant) => OWNS_A_TURN[variant]);

// Which turn variants START the work of a driver generation — a launch, a
// resume, a rework, a consensus draft. A message rides a generation another
// turn started, so a run whose only turns are messages has not been launched:
// the continuation worker's launch arm selects it by the absence of these
// (a message accepted in the launch window, before `startAgentSession` ran).
// Exhaustive over the variant union, like OWNS_A_TURN.
const STARTS_A_GENERATION: Readonly<Record<AgentTurn["variant"], boolean>> = {
  initial: true,
  resume: true,
  rework: true,
  consensus_draft: true,
  live_message: false,
  persistent_message: false,
  steer: false,
};

export const GENERATION_TURN_VARIANTS: readonly AgentTurn["variant"][] = (
  Object.keys(STARTS_A_GENERATION) as AgentTurn["variant"][]
).filter((variant) => STARTS_A_GENERATION[variant]);
