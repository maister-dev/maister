import { dependencyRoute } from "./_lib";

import {
  editDependencySchema,
  editDependency,
} from "@/lib/project-dependencies/commands";

export const PATCH = dependencyRoute(editDependencySchema, editDependency, 200);
