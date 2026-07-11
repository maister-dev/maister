// ADR-129 (W-A, DEC-2): the requirements ledger is a DERIVED read model — never
// stored redundantly. It aggregates the MCP refs a project actually needs from
// three sources (attached package manifests, enabled flow-revision node
// settings, attached agents' capability_profile.mcps) and classifies each. This
// module is PURE (no I/O) — the DB-backed assembly (hub read model, T6.1) feeds
// it the already-loaded sources so SET/CLEAR/re-SET symmetry is testable here.

export type RequirementSource =
  | { kind: "package"; packageName: string; refs: string[] }
  | {
      kind: "flow";
      flowRefId: string;
      required: string[];
      additional: string[];
    }
  | { kind: "agent"; agentId: string; refs: string[] };

export type DeclaredRef = {
  refId: string;
  // A ref is REQUIRED if ANY package/agent declares it or any flow lists it in
  // `required`; ADDITIONAL-only when only flow `additional` lists it.
  required: boolean;
  declaredBy: string[];
};

export type RequirementClass =
  | "bound"
  | "auto"
  | "unbound"
  | "misconfigured"
  | "not_ready";

export type RequirementCandidate = DeclaredRef & {
  // The project_mcp_bindings row for this ref, if any.
  binding?: {
    targetKind: "platform" | "project" | "package";
    enabled: boolean;
    bindableTargetPresent: boolean;
    overlayValid: boolean;
  };
  // Catalog sources that have a record for this ref (grandfather candidates).
  candidateSources: string[];
  // The effective winner is trust-withheld (W-E) / probe-NotReady (W-F).
  effectiveTrustWithheld?: boolean;
  effectiveNotReady?: boolean;
};

export type RequirementEntry = DeclaredRef & {
  classification: RequirementClass;
};

// Aggregate declared refs across sources. A pure union: dropping the last source
// that declares a ref removes it; re-adding restores it (SET/CLEAR/re-SET).
export function deriveDeclaredRefs(
  sources: readonly RequirementSource[],
): DeclaredRef[] {
  const byRef = new Map<
    string,
    { required: boolean; declaredBy: Set<string> }
  >();

  const add = (refId: string, required: boolean, label: string): void => {
    const entry = byRef.get(refId) ?? {
      required: false,
      declaredBy: new Set(),
    };

    entry.required = entry.required || required;
    entry.declaredBy.add(label);
    byRef.set(refId, entry);
  };

  for (const source of sources) {
    if (source.kind === "package") {
      for (const ref of source.refs)
        add(ref, true, `package:${source.packageName}`);
    } else if (source.kind === "agent") {
      for (const ref of source.refs) add(ref, true, `agent:${source.agentId}`);
    } else {
      for (const ref of source.required)
        add(ref, true, `flow:${source.flowRefId}`);
      for (const ref of source.additional)
        add(ref, false, `flow:${source.flowRefId}`);
    }
  }

  return [...byRef.entries()]
    .map(([refId, entry]) => ({
      refId,
      required: entry.required,
      declaredBy: [...entry.declaredBy].sort(),
    }))
    .sort((a, b) => a.refId.localeCompare(b.refId));
}

// Classify one requirement. Order matters: an explicit binding decides the class
// (disabled → unbound opt-out; enabled → bound/misconfigured/not_ready); absent
// binding falls through to grandfather (auto) or unbound.
export function classifyRequirement(
  candidate: RequirementCandidate,
): RequirementClass {
  const { binding } = candidate;

  if (binding) {
    if (!binding.enabled) return "unbound"; // explicit disconnect / opt-out
    if (!binding.bindableTargetPresent || !binding.overlayValid) {
      return "misconfigured";
    }
    if (candidate.effectiveTrustWithheld || candidate.effectiveNotReady) {
      return "not_ready";
    }

    return "bound";
  }

  if (candidate.candidateSources.length === 0) return "unbound";
  if (candidate.effectiveTrustWithheld || candidate.effectiveNotReady) {
    return "not_ready";
  }

  return "auto";
}

export function buildRequirementsLedger(
  candidates: readonly RequirementCandidate[],
): RequirementEntry[] {
  return candidates.map((candidate) => ({
    refId: candidate.refId,
    required: candidate.required,
    declaredBy: candidate.declaredBy,
    classification: classifyRequirement(candidate),
  }));
}
