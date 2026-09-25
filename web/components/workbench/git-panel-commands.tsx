import type { ReactElement } from "react";

import { useTranslations } from "next-intl";

import {
  CopyLine,
  Section,
  type GitState,
} from "@/components/workbench/git-panel-kit";

// ADR-181 D3: the copyable commands — check the publication out locally, and
// restore the newest rescue ref.
export function GitCommandsSection({
  state,
}: {
  state: GitState;
}): ReactElement {
  const t = useTranslations("workbenchGit");

  return (
    <Section id="commands" title={t("section.commands")}>
      {state.commands.checkout.length > 0 ? (
        <>
          <span className="font-mono text-[10px] text-mute">
            {t("commands.checkout")}
          </span>
          {state.commands.checkout.map((command) => (
            <CopyLine
              key={command}
              command={command}
              label={t("commands.copy")}
            />
          ))}
        </>
      ) : (
        <p className="m-0 font-mono text-[10px] text-mute">
          {t("commands.unpublished")}
        </p>
      )}
      {state.commands.restoreRescue ? (
        <>
          <span className="font-mono text-[10px] text-mute">
            {t("commands.restoreRescue")}
          </span>
          <CopyLine
            command={state.commands.restoreRescue}
            label={t("commands.copy")}
          />
        </>
      ) : null}
    </Section>
  );
}
