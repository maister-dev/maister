"use client";

import type { ReactElement } from "react";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { readApiError } from "@/lib/api-error";

// Client-safe local-package list item. `working_dir` and the lock session are
// server-only and intentionally absent (D1/D10); `isDefault` is a plain flag.
export type LocalPackageListItem = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
};

export function LocalPackagesList({
  packages,
}: {
  packages: LocalPackageListItem[];
}): ReactElement {
  const t = useTranslations("studio");
  const tApiErrors = useTranslations("apiErrors");
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {creating ? (
          <>
            <input
              aria-label={t("local.newName")}
              className="min-w-[220px] flex-1 rounded-[10px] border border-line bg-paper px-3 py-2 text-[13px] text-ink placeholder:text-mute"
              data-testid="local-new-name"
              placeholder={t("local.newNamePlaceholder")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void create();
                }
              }}
            />
            <button
              className="rounded-[10px] border border-amber bg-amber px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-white hover:bg-amber-2 disabled:opacity-60"
              data-testid="local-new-create"
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
          </>
        ) : (
          <button
            className="rounded-[10px] border border-line bg-ivory px-3 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-amber"
            data-testid="local-new"
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

      {packages.length > 0 ? (
        <ul className="flex list-none flex-col gap-2" data-testid="local-list">
          {packages.map((pkg) => (
            <li key={pkg.id}>
              <Link
                className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-paper px-5 py-4 transition-colors hover:border-amber"
                href={`/studio/edit/${pkg.id}`}
              >
                <span className="text-[15px] font-semibold text-ink">
                  {pkg.name}
                </span>
                {pkg.isDefault ? (
                  <span className="rounded-full border border-amber-line bg-amber-soft px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em] text-amber">
                    {t("local.defaultBadge")}
                  </span>
                ) : null}
                <span className="ml-auto truncate font-mono text-[11.5px] text-mute">
                  {pkg.slug}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-mute">{t("local.empty")}</p>
      )}
    </div>
  );
}
