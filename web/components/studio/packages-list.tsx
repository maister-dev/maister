"use client";

import type { PackageGroup } from "@/lib/studio/group-packages";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

type TrustFilter = "all" | "trusted" | "untrusted";

const KIND_LABEL_KEYS: { key: keyof PackageGroup["counts"]; label: string }[] =
  [
    { key: "flows", label: "kindFlows" },
    { key: "skills", label: "kindSkills" },
    { key: "platformAgents", label: "kindAgents" },
    { key: "subagents", label: "kindSubagents" },
    { key: "mcps", label: "kindMcps" },
    { key: "rules", label: "kindRules" },
  ];

export function PackagesList({ groups }: { groups: PackageGroup[] }) {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [trust, setTrust] = useState<TrustFilter>("all");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create a fresh local package (same flow as /studio/local) and open the
  // editor — a create affordance directly on the central packages view.
  async function create(): Promise<void> {
    const trimmed = name.trim();

    if (trimmed === "") return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/studio/local-packages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });

      if (!res.ok) {
        setError(await readApiError(res, tApiErrors));

        return;
      }

      const created = (await res.json()) as { id: string };

      router.push(`/studio/edit/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return groups.filter((group) => {
      const matchesQuery =
        q === "" ||
        group.name.toLowerCase().includes(q) ||
        group.sourceUrl.toLowerCase().includes(q);
      const matchesTrust =
        trust === "all" ||
        (trust === "untrusted" ? group.needsTrust : !group.needsTrust);

      return matchesQuery && matchesTrust;
    });
  }, [groups, query, trust]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={t("filterName")}
          className="min-w-[220px] flex-1 rounded-[10px] border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-mute"
          placeholder={t("filterName")}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label={t("filterTrust")}
          className="rounded-[10px] border border-line bg-paper px-3 py-2 text-[13px] text-ink"
          value={trust}
          onChange={(event) => setTrust(event.target.value as TrustFilter)}
        >
          <option value="all">{t("trustAll")}</option>
          <option value="trusted">{t("trustTrusted")}</option>
          <option value="untrusted">{t("trustUntrusted")}</option>
        </select>
        {creating ? (
          <span className="flex items-center gap-2">
            <input
              aria-label={t("local.newName")}
              className="min-w-[200px] rounded-[10px] border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-mute"
              data-testid="studio-new-name"
              placeholder={t("local.newNamePlaceholder")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void create();
                }
                if (event.key === "Escape") setCreating(false);
              }}
            />
            <button
              className="rounded-[10px] border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
              data-testid="studio-new-create"
              disabled={busy || name.trim() === ""}
              type="button"
              onClick={() => void create()}
            >
              {t("local.create")}
            </button>
            <button
              className="rounded-[10px] border border-line bg-paper px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-mute hover:border-mute hover:text-ink-2"
              type="button"
              onClick={() => {
                setCreating(false);
                setName("");
                setError(null);
              }}
            >
              {t("local.cancel")}
            </button>
          </span>
        ) : (
          <button
            className="rounded-[10px] border border-line bg-ivory px-3 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber"
            data-testid="studio-new-package"
            type="button"
            onClick={() => setCreating(true)}
          >
            {t("local.newPackage")}
          </button>
        )}
      </div>

      {error ? (
        <p
          className="rounded-[10px] border border-danger-line bg-danger-soft px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {filtered.length > 0 ? (
        <ul className="flex list-none flex-col gap-2">
          {filtered.map((group) => (
            <li key={group.key}>
              <Link
                className="flex flex-col gap-2 rounded-[14px] border border-line bg-paper px-5 py-4 transition-colors hover:border-amber"
                href={`/studio/packages/${encodeURIComponent(group.name)}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink">
                    {group.name}
                  </span>
                  {group.isLocal ? (
                    <span className="rounded-full border border-line bg-ivory px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-mute">
                      {t("localBadge")}
                    </span>
                  ) : null}
                  <span className="font-mono text-[11px] text-mute">
                    {group.versions[0]?.versionLabel}
                  </span>
                  <span
                    className={
                      group.needsTrust
                        ? "ml-auto font-mono text-[11px] font-semibold text-amber"
                        : "ml-auto font-mono text-[11px] text-mute"
                    }
                  >
                    {group.needsTrust ? t("needsTrust") : t("trusted")}
                  </span>
                </div>
                <div className="truncate font-mono text-[11.5px] text-mute">
                  {group.sourceUrl}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {KIND_LABEL_KEYS.filter(
                    ({ key }) => group.counts[key] > 0,
                  ).map(({ key, label }) => (
                    <span
                      key={key}
                      className="rounded-full bg-ivory px-2 py-px font-mono text-[10.5px] text-ink-2"
                    >
                      {group.counts[key]} {t(label)}
                    </span>
                  ))}
                  <span className="ml-auto font-mono text-[10.5px] text-mute">
                    {t("usedBy", { count: group.attachedProjectCount })}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-mute">{t("packagesEmpty")}</p>
      )}
    </div>
  );
}
