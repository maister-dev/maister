import { dependencyRoute } from "../_lib";

import {
  recoverDependencySchema,
  resubmitDependency,
} from "@/lib/project-dependencies/commands";

export const POST = dependencyRoute(
  recoverDependencySchema,
  resubmitDependency,
  202,
);
