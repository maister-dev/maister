"use client";

import type { ReactElement } from "react";

import { useEffect, useState } from "react";

type InstallCommandProps = {
  command: string;
  copyLabel: string;
  copiedLabel: string;
};

export function InstallCommand({
  command,
  copyLabel,
  copiedLabel,
}: InstallCommandProps): ReactElement {
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    if (!isCopied) return undefined;
    const timer = window.setTimeout(() => setIsCopied(false), 1800);

    return () => window.clearTimeout(timer);
  }, [isCopied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setIsCopied(true);
    } catch {
      setIsCopied(false);
    }
  };

  return (
    <div className="install-command">
      <span aria-hidden="true" className="install-prompt">
        $
      </span>
      <code>{command}</code>
      <button
        aria-live="polite"
        className={`install-copy${isCopied ? " is-copied" : ""}`}
        type="button"
        onClick={() => void copy()}
      >
        {isCopied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
