"use client";

import type { InstallationAgentGrant } from "@/lib/agents/installation-access-types";
import type { FormEvent, ReactElement } from "react";
import type { KnowledgeDelivery } from "@/components/brain/knowledge-client";

import { useRef, useState } from "react";
import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  createCoordinatorBinding,
  createSpecialistBinding,
  updateSpecialistBinding,
} from "@/app/(app)/settings/specialists/actions";
import {
  knowledgeClientErrorKey,
  knowledgeDeliveryKey,
} from "@/components/brain/knowledge-client";
import { INSTALLATION_AGENT_SCOPES } from "@/lib/agents/installation-access-types";
import { MaisterError } from "@/lib/errors-core";

export function BindingReviewForm({
  companyId,
  bindingKind,
  example,
  canGrantInstallation,
  editing,
}: {
  companyId: string;
  bindingKind: "specialist" | "coordinator";
  example: Readonly<Record<string, unknown>>;
  canGrantInstallation?: boolean;
  editing?: Readonly<{
    agentId: string;
    bindingId: string;
    revision: number;
    grant?: InstallationAgentGrant;
  }>;
}): ReactElement {
  const t = useTranslations("specialistAssignments");
  const knowledge = useTranslations("knowledge");
  const router = useRouter();
  const delivery = useRef<KnowledgeDelivery | null>(null);
  const [installation, setInstallation] = useState(Boolean(editing?.grant));
  const [vault, setVault] = useState(editing?.grant?.memoryEnabled ?? false);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);

    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const value: unknown = JSON.parse(
        String(form.get("configuration") ?? ""),
      );

      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new MaisterError(
          "CONFIG",
          "Binding review requires a JSON object",
        );
      const body = {
        ...value,
        owner: { kind: "company", companyId },
        ...(editing && { expectedRevision: editing.revision }),
        ...(canGrantInstallation &&
          bindingKind === "specialist" &&
          (installation || editing) && {
            installationGrant: installation
              ? {
                  schemaVersion: 1,
                  reach: "active_projects",
                  scopes: form.getAll("installationScope"),
                  memoryEnabled: vault,
                }
              : null,
          }),
      };
      const agentId = String(form.get("agentId") ?? "");
      const binding = {
        ...body,
        idempotencyKey: knowledgeDeliveryKey(delivery, {
          bindingKind,
          agentId,
          body,
        }),
      };
      const result =
        bindingKind === "specialist"
          ? editing
            ? await updateSpecialistBinding({
                agentId,
                bindingId: editing.bindingId,
                binding,
              })
            : await createSpecialistBinding({ agentId, binding })
          : await createCoordinatorBinding(binding);

      if (!result.ok)
        throw new MaisterError(
          result.code,
          "The reviewed configuration was refused",
        );
      setSaved(true);
      router.refresh();
    } catch (error) {
      setError(
        knowledge(
          error instanceof SyntaxError
            ? "errorInput"
            : knowledgeClientErrorKey(error),
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-4 rounded-xl border border-line bg-paper p-5"
      onSubmit={submit}
    >
      <h2 className="font-semibold">
        {t(
          editing
            ? "editInstallationBinding"
            : bindingKind === "specialist"
              ? "newBinding"
              : "newCoordinator",
        )}
      </h2>
      {bindingKind === "specialist" ? (
        <label className="block text-sm">
          {t("qualifiedAgent")}
          <input
            required
            className="mt-1 block w-full rounded border border-line px-3 py-2"
            defaultValue={editing?.agentId}
            maxLength={128}
            name="agentId"
            readOnly={Boolean(editing)}
          />
        </label>
      ) : null}
      {canGrantInstallation && bindingKind === "specialist" ? (
        <fieldset className="space-y-3">
          <label className="flex items-center gap-2">
            <input
              checked={installation}
              type="checkbox"
              onChange={(event) => setInstallation(event.target.checked)}
            />
            {t("installationGrant")}
          </label>
          {installation ? (
            <>
              <p className="text-sm text-mute">
                {t("installationGrantDescription")}
              </p>
              <label className="flex items-center gap-2">
                <input
                  checked={vault}
                  type="checkbox"
                  onChange={(event) => setVault(event.target.checked)}
                />
                {t("installationMemory")}
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                {INSTALLATION_AGENT_SCOPES.map((scope) => (
                  <label
                    key={scope}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      defaultChecked={
                        editing?.grant?.scopes.includes(scope) ??
                        scope === "projects:read"
                      }
                      disabled={!vault && scope.startsWith("agent_memory:")}
                      name="installationScope"
                      type="checkbox"
                      value={scope}
                    />
                    <code>{scope}</code>
                  </label>
                ))}
              </div>
            </>
          ) : null}
        </fieldset>
      ) : null}
      <label className="block text-sm">
        {t("reviewedConfiguration")}
        <textarea
          required
          className="mt-1 block w-full rounded border border-line px-3 py-2 font-mono"
          defaultValue={JSON.stringify(example, null, 2)}
          maxLength={32768}
          name="configuration"
          rows={12}
          spellCheck={false}
        />
      </label>
      <Button isPending={pending} type="submit" variant="primary">
        {t("saveBinding")}
      </Button>
      {saved ? (
        <p className="text-sm" role="status">
          {t("bindingSaved")}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
