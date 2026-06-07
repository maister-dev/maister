-- M22 layout reversal (ADR-062): authored flow-graph node positions move into
-- the flow.yaml `presentation` section (shipped with the immutable bundle), so
-- the per-project runtime layout store added in migration 0024 is dropped.
DROP TABLE IF EXISTS "flow_graph_layouts";
