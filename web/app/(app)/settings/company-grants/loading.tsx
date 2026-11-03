import type { ReactElement } from "react";

import { RouteSkeleton } from "@/components/feedback/route-skeleton";

export default function Loading(): ReactElement {
  return <RouteSkeleton variant="project" />;
}
