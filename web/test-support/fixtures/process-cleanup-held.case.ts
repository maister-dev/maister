import { it } from "vitest";

import { holdRealFixtureStack } from "./process-cleanup-stack";

it("holds the real production stack after readiness", holdRealFixtureStack);
