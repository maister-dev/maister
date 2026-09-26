import path from "node:path";

// ADR-163 e2e: flow-target-delegation holds the delegated FLOW children at their
// first node until it has seen the coordinator park. A two-node cli graph
// otherwise reaches `Review` before the coordinator's turn ends, and a
// coordinator with nothing pending correctly completes without parking — so the
// wake the spec proves never runs. The seed bakes this path into the child
// manifest; the spec removes it before the launch and creates it after the park.
export const DELEGATED_FLOW_RELEASE = path.resolve(
  "e2e/.runtime/delegated-flow.release",
);
