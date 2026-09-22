import "./omit-watchdog.mjs";

import { it } from "vitest";

import { holdRealFixtureStack } from "./process-cleanup-stack";

it(
  "holds the real stack with only the parent watchdog omitted",
  holdRealFixtureStack,
);
