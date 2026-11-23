"use client";

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type {
  CatalogKind,
  CatalogPreview,
  CatalogReceipt,
  SearchResponse,
  SearchResult,
} from "@/lib/local-packages/catalog-contract";
import type { ReactElement } from "react";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import {
  parsePackageManifest,
  PACKAGE_MANIFEST_FILENAME,
} from "@/lib/local-packages/manifest";
import {
  inlineSelectHref,
  skillScreenHref,
} from "@/lib/local-packages/composition";

type Origin = {
  sourceId: string;
  selector: string;
  destination: string;
  importId: string;
  kind: CatalogKind;
  pin: string;
};
function readOrigins(
  files: AuthoredFlowPackageFile[],
  kind: CatalogKind,
): Origin[] {
  return files.flatMap((file) => {
    if (!/^catalog-origins\/[a-f0-9]{64}\.json$/.test(file.path)) return [];
    try {
      const record = JSON.parse(file.content) as Partial<Origin>;

      return record.kind === kind &&
        ["sourceId", "selector", "destination", "importId", "pin"].every(
          (key) => typeof record[key as keyof Origin] === "string",
        )
        ? [record as Origin]
        : [];
    } catch {
      return [];
    }
  });
}
async function response<T>(req: Promise<Response>): Promise<T> {
  const res = await req;
  const data = await res.json();

  if (!res.ok) throw new Error(data.message ?? String(res.status));

  return data as T;
}
const btn =
  "rounded-md border border-line bg-ivory px-3 py-1.5 text-sm text-ink disabled:opacity-50";
const field =
  "rounded-md border border-line bg-paper px-2 py-1 text-sm text-ink";

export function CatalogImportPanel({
  packageId,
  kind,
  files,
  dirty,
  onApplied,
}: {
  packageId: string;
  kind: CatalogKind;
  files: AuthoredFlowPackageFile[];
  dirty: boolean;
  onApplied: () => void;
}): ReactElement {
  const t = useTranslations("studio.catalog");
  const router = useRouter();
  const base =
    "/api/studio/local-packages/" + encodeURIComponent(packageId) + "/catalog";
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, "draft" | "upstream">>(
    {},
  );
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef("");
  const alive = useRef(true);
  const manifest = parsePackageManifest(
    files.find((f) => f.path === PACKAGE_MANIFEST_FILENAME)?.content ?? "",
  );
  const roots = manifest.ok
    ? manifest.model.capabilities.map((c) => c.path)
    : [];
  const [root, setRoot] = useState(
    roots.length === 1 ? roots[0] : roots.length > 1 ? "" : "capability",
  );
  const origins = readOrigins(files, kind);

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open || !q.trim()) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      void response<SearchResponse>(
        fetch(base + "/search?" + new URLSearchParams({ kind, q }), {
          signal: controller.signal,
        }),
      )
        .then((reply) => {
          if (!controller.signal.aborted) {
            setData(reply);
            setSearching(false);
          }
        })
        .catch((e: Error) => {
          if (!controller.signal.aborted) {
            setError(e.message);
            setSearching(false);
          }
        });
    }, 250);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [base, kind, open, q]);
  function query(value: string): void {
    setQ(value);
    setData(null);
    setSelected(null);
    setPreview(null);
    setError("");
    setSearching(Boolean(value.trim()));
  }
  function choose(item: SearchResult): void {
    setSelected(item);
    setPreview(null);
    setError("");
    const slug = item.name
      .split("/")
      .at(-1)!
      .replace(/[^a-zA-Z0-9._-]+/g, "-");

    setName(slug);
    if (!dirty && slug && (kind === "mcp" || root)) {
      void review({
        sourceId: item.sourceId,
        selector: item.resultId,
        destination:
          kind === "skill"
            ? root + "/skills/" + slug
            : "mcps/" + slug + ".yaml",
      });
    }
  }
  async function review(item: {
    sourceId: string;
    selector: string;
    destination: string;
    importId?: string;
  }): Promise<void> {
    setBusy(true);
    setError("");
    setPreview(null);
    setChoices({});
    try {
      const refreshed = await response<CatalogPreview>(
        fetch(base + "/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, ...item }),
        }),
      );

      if (alive.current) {
        setPreview(refreshed);
        requestKey.current = crypto.randomUUID();
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t("error"));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function apply(): Promise<void> {
    if (!preview || dirty) return;
    setBusy(true);
    setError("");
    try {
      const payload = {
        previewId: preview.previewId,
        expectedDraftBase: preview.expectedDraftBase,
        requestKey: requestKey.current,
        resolutions: Object.entries(choices).map(([path, use]) => ({
          path,
          use,
        })),
      };
      let receipt = await response<CatalogReceipt>(
        fetch(base + "/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );

      if (receipt.state === "pending")
        receipt = await response<CatalogReceipt>(
          fetch(base + "/operations/" + receipt.operationId),
        );
      if (receipt.state !== "applied") throw new Error(t("pending"));
      if (alive.current) {
        const stem = preview.destination.split("/").at(-1)!;

        setOpen(false);
        onApplied();
        router.push(
          kind === "skill"
            ? skillScreenHref(packageId, stem)
            : inlineSelectHref(packageId, "mcps", stem.replace(/\.yaml$/, "")),
        );
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t("error"));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!open)
    return (
      <button
        className={btn}
        data-testid="catalog-open"
        type="button"
        onClick={() => {
          setOpen(true);
          query("");
        }}
      >
        {t("open")}
      </button>
    );

  return (
    <section
      aria-label={t("open")}
      className="flex w-full flex-col gap-2 rounded-lg border border-line bg-paper p-3"
      data-testid="catalog-panel"
    >
      <div className="flex gap-2">
        <input
          aria-label={t("search")}
          className={field + " grow"}
          disabled={busy}
          placeholder={t("search")}
          type="search"
          value={q}
          onChange={(e) => query(e.target.value)}
        />
        <button
          className={btn}
          disabled={busy}
          type="button"
          onClick={() => setOpen(false)}
        >
          {t("close")}
        </button>
      </div>
      {dirty ? <p role="status">{t("dirty")}</p> : null}
      {searching ? <p role="status">{t("searching")}</p> : null}
      {data && !data.results.length ? <p role="status">{t("empty")}</p> : null}
      {data?.sources
        .filter((s) => s.state !== "available")
        .map((s) => (
          <p key={s.sourceId} role="status">
            {s.sourceId}:{" "}
            {t(s.state === "rate_limited" ? "rateLimit" : "unavailable")}
          </p>
        ))}
      {data?.results.length ? (
        <ul className="max-h-44 overflow-y-auto">
          {data.results.map((r) => (
            <li key={r.sourceId + "/" + r.resultId}>
              <button
                className={btn}
                disabled={busy}
                type="button"
                onClick={() => choose(r)}
              >
                {r.name} · {r.publisher}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {data?.nextCursor ? (
        <button
          className={btn}
          disabled={busy}
          type="button"
          onClick={async () => {
            const cursor = data.nextCursor;

            if (!cursor) return;
            setBusy(true);
            try {
              const next = await response<SearchResponse>(
                fetch(
                  base + "/search?" + new URLSearchParams({ kind, q, cursor }),
                ),
              );

              if (alive.current)
                setData({
                  ...next,
                  results: [...data.results, ...next.results],
                });
            } catch (e) {
              if (alive.current)
                setError(e instanceof Error ? e.message : t("error"));
            } finally {
              if (alive.current) setBusy(false);
            }
          }}
        >
          {t("more")}
        </button>
      ) : null}
      {selected ? (
        <div className="flex flex-wrap gap-2">
          {kind === "skill" && roots.length > 1 ? (
            <select
              aria-label={t("root")}
              className={field}
              disabled={busy}
              value={root}
              onChange={(e) => {
                setRoot(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">{t("root")}</option>
              {roots.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          ) : null}
          <label>
            {t("localName")}{" "}
            <input
              className={field}
              disabled={busy}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <button
            className={btn}
            disabled={busy || dirty || !name || (!root && kind === "skill")}
            type="button"
            onClick={() =>
              void review({
                sourceId: selected.sourceId,
                selector: selected.resultId,
                destination:
                  kind === "skill"
                    ? root + "/skills/" + name
                    : "mcps/" + name + ".yaml",
              })
            }
          >
            {t("preview")}
          </button>
        </div>
      ) : null}
      {origins.map((origin) => (
        <button
          key={origin.importId}
          className={btn}
          disabled={busy || dirty}
          type="button"
          onClick={() =>
            void review({
              sourceId: origin.sourceId,
              selector: origin.selector,
              destination: origin.destination,
              importId: origin.importId,
            })
          }
        >
          {t("update")} · {origin.destination}
        </button>
      ))}
      {error ? <p role="alert">{error}</p> : null}
      {preview ? (
        <div className="space-y-2" data-testid="catalog-preview">
          <p>
            {preview.publisher} ·{" "}
            <a
              className="underline"
              href={preview.sourceUrl}
              rel="noreferrer"
              target="_blank"
            >
              {preview.pin}
            </a>{" "}
            → {preview.destination}
          </p>
          <p className="break-all font-mono text-xs">
            SHA-256 {preview.digest}
          </p>
          {preview.notices.length ? (
            <p>
              {t("notices")}: {preview.notices.join(", ")}
            </p>
          ) : null}
          {preview.configuration.length ? (
            <p>{preview.configuration.join(" · ")}</p>
          ) : null}
          {preview.affectedRefs?.length ? (
            <p>
              {t("affectedRefs")}: {preview.affectedRefs.join(", ")}
            </p>
          ) : null}
          {preview.files.map((file) => (
            <details key={file.path}>
              <summary>
                {t(file.change)} · {file.path}
              </summary>
              {file.before !== null ? (
                <pre
                  aria-label={t("draft")}
                  className="max-h-64 overflow-auto whitespace-pre-wrap bg-ivory p-2"
                >
                  {file.before}
                </pre>
              ) : null}
              {file.after !== null ? (
                <pre
                  aria-label={t("upstream")}
                  className="max-h-64 overflow-auto whitespace-pre-wrap p-2"
                >
                  {file.after}
                </pre>
              ) : null}
              {file.change === "conflict" ? (
                <select
                  aria-label={t("resolve") + " " + file.path}
                  className={field}
                  value={choices[file.path] ?? ""}
                  onChange={(e) => {
                    const value = e.target.value;

                    if (value === "upstream" || value === "draft")
                      setChoices((c) => ({ ...c, [file.path]: value }));
                  }}
                >
                  <option value="">{t("resolve")}</option>
                  <option value="upstream">{t("upstream")}</option>
                  <option value="draft">{t("draft")}</option>
                </select>
              ) : null}
            </details>
          ))}
          <button
            className={btn}
            data-testid="catalog-apply"
            disabled={
              busy ||
              dirty ||
              preview.files.some(
                (f) => f.change === "conflict" && !choices[f.path],
              )
            }
            type="button"
            onClick={() => void apply()}
          >
            {t("apply")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
