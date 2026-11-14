import type { ReactElement } from "react";

import { ConfigPersistControl } from "./config-persist-control";

export function ConfigPersistBanner({
  slug,
  actorUserId,
  exportRevision,
}: {
  slug: string;
  actorUserId: string;
  exportRevision: string;
}): ReactElement {
  return (
    <ConfigPersistControl
      dismissible
      actorUserId={actorUserId}
      exportRevision={exportRevision}
      slug={slug}
    />
  );
}
