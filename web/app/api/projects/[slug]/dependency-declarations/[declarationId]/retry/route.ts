import { dependencyRoute } from "../_lib";

import {
  retryDependencySchema,
  resubmitDependency,
} from "@/lib/project-dependencies/commands";

export const POST = dependencyRoute(
  retryDependencySchema,
  resubmitDependency,
  202,
);
