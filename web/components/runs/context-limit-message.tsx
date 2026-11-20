import type { ReactElement } from "react";
import type { AcpContextFailureReason } from "../../../runtime/acp-context-failure";

import { useTranslations } from "next-intl";

export function ContextLimitMessage({
  reason,
}: {
  reason: AcpContextFailureReason;
}): ReactElement {
  const t = useTranslations("run.terminalCause.reasons");

  return <>{t(reason)}</>;
}
