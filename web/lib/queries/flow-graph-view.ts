import "server-only";

// The pure topology builder + its types live in the client-safe
// `@/lib/flows/graph/topology` so a client live-preview can compile
// yaml→graph→topology in the browser (T3.1). This re-export keeps the existing
// `@/lib/queries/flow-graph-view` import surface and its `server-only` boundary
// intact for server callers (no behavior change).
export {
  buildGraphTopology,
  type GraphNodeRole,
  type GraphEdgeRole,
  type DeclaredGateSummary,
  type GraphTopologyNode,
  type GraphTopologyEdge,
  type GraphTopology,
} from "@/lib/flows/graph/topology";
