// Consensus artifacts that hold agent session output. A consensus participant
// runs with repository access, so its text can quote any file it read; these
// carry the same repository-content grant as an execution object (ADR-053).
export const CONSENSUS_DRAFT_ARTIFACT_DEF = "default:consensus-draft";
export const CONSENSUS_VERDICT_ARTIFACT_DEF = "default:consensus-verdict";
export const CONSENSUS_SYNTHESIS_ARTIFACT_DEF = "default:consensus-synthesis";

export const CONSENSUS_AGENT_OUTPUT_ARTIFACT_DEFS: ReadonlySet<string> =
  new Set([
    CONSENSUS_DRAFT_ARTIFACT_DEF,
    CONSENSUS_VERDICT_ARTIFACT_DEF,
    CONSENSUS_SYNTHESIS_ARTIFACT_DEF,
  ]);
