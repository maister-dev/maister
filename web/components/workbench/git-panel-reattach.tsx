import type { ReactElement } from "react";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";

import {
  primary,
  Section,
  type GitSectionProps,
} from "@/components/workbench/git-panel-kit";

// ADR-181 D10: a removed or vanished worktree, re-created from the first source
// that resolves (local branch → publication → archive ref).
export function GitReattachSection({
  state,
  mutate,
  actionButton,
}: Pick<GitSectionProps, "state" | "mutate" | "actionButton">): ReactElement {
  const t = useTranslations("workbenchGit");

  return (
    <Section id="reattach" title={t("section.reattach")}>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[10px] text-ink-2">
        {(["local", "published", "archive"] as const).map((source) => (
          <li key={source}>
            {t(`reattach.${source}`)}:{" "}
            {state.reattachSources[source]?.slice(0, 12) ?? "—"}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {actionButton({
          id: "reattach",
          tone: primary,
          icon: <ArrowPathIcon aria-hidden="true" className="h-3.5 w-3.5" />,
          onClick: () =>
            void mutate("reattach", "reattach", {}, () => undefined),
        })}
      </div>
    </Section>
  );
}
