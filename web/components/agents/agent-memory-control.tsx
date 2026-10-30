"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { AgentMemoryDrawer } from "@/components/board/panels/agent-memory-drawer";

export function AgentMemoryControl({
  slug,
  agentId,
  canEdit,
}: {
  slug: string;
  agentId: string;
  canEdit: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const t = useTranslations("agentsAttach");

  return (
    <>
      <button
        className="inline-flex min-h-9 items-center rounded-lg border border-line bg-ivory px-3 text-sm font-semibold"
        type="button"
        onClick={() => setOpen(true)}
      >
        {t("memoryTitle")}
      </button>
      {open ? (
        <AgentMemoryDrawer
          agentId={agentId}
          agentLabel={agentId}
          canEdit={canEdit}
          labels={{
            title: t("memoryTitle"),
            close: t("memoryClose"),
            edit: t("memoryEdit"),
            save: t("memorySave"),
            cancel: t("memoryCancel"),
            clear: t("memoryClear"),
            clearConfirm: t("memoryClearConfirm"),
            clearConfirmTitle: t("memoryClearConfirmTitle"),
            clearError: t("memoryClearError"),
            empty: t("memoryEmpty"),
            size: t.raw("memorySize"),
            overCap: t("memoryOverCap"),
            conflict: t("memoryConflict"),
            loadError: t("memoryLoadError"),
          }}
          slug={slug}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
