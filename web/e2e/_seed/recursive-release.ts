import path from "node:path";

// The recursive journey holds research completion until it has observed the
// root park. Fast child workers must not remove the park/wake ordering that
// this test explicitly exercises. The owning spec releases on every exit.
export const RECURSIVE_RESEARCH_RELEASE = path.resolve(
  "e2e/.runtime/recursive-research.release",
);
