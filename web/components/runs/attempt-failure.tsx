import type { ReactElement } from "react";
import type { MaisterErrorCode } from "@/lib/errors-core";

import { isMaisterErrorCode } from "@/lib/errors-core";

export interface AttemptFailureLabels {
  unknown: string;
  code: string;
  exitCode: string;
  codes: Partial<Record<MaisterErrorCode, string>>;
}

/** Board viewers receive only known codes, never raw agent or tool output. */
export function AttemptFailure({
  status,
  errorCode,
  exitCode,
  labels,
}: {
  status: string;
  errorCode: string | null;
  exitCode: number | null;
  labels: AttemptFailureLabels;
}): ReactElement | null {
  if (status !== "Failed") return null;

  const code = isMaisterErrorCode(errorCode) ? errorCode : null;

  return (
    <div className="mt-2 text-sm text-danger" data-testid="attempt-failure">
      <p>{(code && labels.codes[code]) || labels.unknown}</p>
      {code ? (
        <p className="font-mono text-xs">
          {labels.code}: {code}
        </p>
      ) : null}
      {exitCode !== null && Number.isInteger(exitCode) ? (
        <p className="font-mono text-xs">
          {labels.exitCode}: {exitCode}
        </p>
      ) : null}
    </div>
  );
}
