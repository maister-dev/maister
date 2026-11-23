"use client";

import type { AgentDefinitionView } from "@/lib/agents/activity-access";

import { Button, Tooltip } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { RawDiff } from "@/components/runs/raw-diff";
import { unifiedLineDiff } from "@/lib/flows/editor/text-diff";

type Settings = NonNullable<AgentDefinitionView["instance"]>;

function promptDiff(before: string, after: string): string {
  // Bound the quadratic line matcher for large prompts; a full replacement is still byte-complete.
  if (before.split("\n").length * after.split("\n").length > 1_000_000)
    return [unifiedLineDiff(before, ""), unifiedLineDiff("", after)].join("\n");

  return unifiedLineDiff(before, after);
}

export function ProjectAgentDefinitionEditor({
  endpoint,
  canEdit,
  initialDiffOpen,
  instance,
  prompt,
}: {
  endpoint: string;
  canEdit: boolean;
  initialDiffOpen: boolean;
  instance: Settings;
  prompt: string;
}) {
  const t = useTranslations("agentActivity");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [showDiff, setShowDiff] = useState(initialDiffOpen);
  const [draft, setDraft] = useState(prompt);
  const [additions, setAdditions] = useState(instance.additionalMcpRefs);
  const [restore, setRestore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<
    "instanceStale" | "instanceError" | "instanceSaved" | null
  >(null);
  const inherited = new Set(instance.inheritedMcpRefs);
  const refs = [
    ...new Set([
      ...instance.additionalMcpRefs,
      ...(editing
        ? instance.connectedMcpRefs.filter((ref) => !inherited.has(ref))
        : []),
    ]),
  ].sort();

  async function save(): Promise<void> {
    setSaving(true);
    setOutcome(null);
    try {
      const body = {
        expectedInstallId: instance.expectedInstallId,
        schedulesRevision: instance.revision,
        ...(restore
          ? { promptOverride: null }
          : draft !== prompt
            ? { promptOverride: draft }
            : {}),
        ...(JSON.stringify(additions) !==
        JSON.stringify(instance.additionalMcpRefs)
          ? { additionalMcpRefs: additions }
          : {}),
      };
      const result = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!result.ok) {
        setOutcome(result.status === 409 ? "instanceStale" : "instanceError");

        return;
      }
      setEditing(false);
      setOutcome("instanceSaved");
      router.refresh();
    } catch {
      setOutcome("instanceError");
    } finally {
      setSaving(false);
    }
  }

  function begin(): void {
    setDraft(prompt);
    setAdditions(instance.additionalMcpRefs);
    setRestore(false);
    setOutcome(null);
    setEditing(true);
  }

  return (
    <section aria-label={t("instancePrompt")} className="space-y-3">
      <div className="flex items-center gap-2">
        <strong>{t("instancePrompt")}</strong>
        {instance.diverged ? (
          <Tooltip>
            <Button
              isIconOnly
              aria-expanded={showDiff}
              aria-label={t("instanceDiverged")}
              size="sm"
              variant="ghost"
              onPress={() => setShowDiff(!showDiff)}
            >
              !
            </Button>
            <Tooltip.Content>{t("instanceDiverged")}</Tooltip.Content>
          </Tooltip>
        ) : null}
        {canEdit && !editing ? (
          <Button size="sm" variant="secondary" onPress={begin}>
            {t("instanceEdit")}
          </Button>
        ) : null}
      </div>
      {showDiff && instance.diverged ? (
        <RawDiff diff={promptDiff(instance.packagePrompt, prompt)} />
      ) : null}
      {editing ? (
        <textarea
          aria-label={t("instancePrompt")}
          className="min-h-48 w-full rounded border border-line bg-paper p-3"
          disabled={saving}
          maxLength={65536}
          value={draft}
          onChange={(e) => {
            setRestore(false);
            setDraft(e.target.value);
          }}
        />
      ) : (
        <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-paper p-4 text-sm">
          {prompt}
        </pre>
      )}
      {inherited.size > 0 ? (
        <div className="space-y-1">
          <span>{t("instanceInheritedMcps")}</span>
          <ul>
            {[...inherited].map((ref) => (
              <li key={ref} className="font-mono text-sm">
                {ref}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {refs.length > 0 ? (
        <fieldset className="flex flex-wrap gap-3">
          <legend>{t("instanceMcps")}</legend>
          {refs.map((ref) => (
            <label
              key={ref}
              className="flex items-center gap-1 font-mono text-sm"
            >
              <input
                checked={additions.includes(ref)}
                disabled={!editing || saving}
                type="checkbox"
                onChange={(event) =>
                  setAdditions(
                    event.target.checked
                      ? [...additions, ref].sort()
                      : additions.filter((value) => value !== ref),
                  )
                }
              />
              {ref}
            </label>
          ))}
        </fieldset>
      ) : null}
      {editing ? (
        <div className="flex gap-2">
          {instance.promptOverridden ? (
            <Button
              isDisabled={saving}
              size="sm"
              variant="secondary"
              onPress={() => {
                setDraft(instance.packagePrompt);
                setRestore(true);
              }}
            >
              {t("instanceRestore")}
            </Button>
          ) : null}
          <Button
            isDisabled={
              !draft.trim() ||
              (!restore &&
                draft === prompt &&
                JSON.stringify(additions) ===
                  JSON.stringify(instance.additionalMcpRefs))
            }
            isPending={saving}
            size="sm"
            onPress={() => void save()}
          >
            {t("instanceSave")}
          </Button>
          <Button
            isDisabled={saving}
            size="sm"
            variant="ghost"
            onPress={() => {
              setEditing(false);
              setAdditions(instance.additionalMcpRefs);
              setOutcome(null);
            }}
          >
            {t("instanceCancel")}
          </Button>
        </div>
      ) : null}
      {outcome ? (
        <p role={outcome === "instanceSaved" ? "status" : "alert"}>
          {t(outcome)}
        </p>
      ) : null}
    </section>
  );
}
