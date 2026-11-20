"use client";

import type { getProposalReviewDetail } from "@/lib/queries/inbox-review-actions";
import type {
  listProposalReviews,
  ReviewKind,
  ReviewSelector,
} from "@/lib/queries/knowledge-memory-reviews";

import { Button, Modal, Input } from "@heroui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

type Page = Awaited<ReturnType<typeof listProposalReviews>>;
type ReviewItem = Page["items"][number];
type ReviewDetail = Awaited<ReturnType<typeof getProposalReviewDetail>>;
type Outcome = "applied" | "rejected" | "conflict" | "unavailable" | "refused";
type ReviewSubmission = Readonly<{
  body: string;
  titles: readonly string[];
}>;
const kinds = ["vault", "brain", "knowledge"] as const;

function rowKey(row: ReviewItem) {
  return JSON.stringify([row.kind, row.id, row.version]);
}

function ReviewPreview({
  source,
  close,
}: {
  source: ReviewSelector;
  close: () => void;
}) {
  const t = useTranslations("inbox.reviews");
  const [request, setRequest] = useState<{ cursors: readonly string[] }>({
    cursors: [],
  });
  const [result, setResult] = useState<{
    request: typeof request;
    preview: ReviewDetail | "unavailable";
  } | null>(null);
  const preview = result?.request === request ? result.preview : null;
  const cursor = request.cursors.at(-1);
  const nextCursor = preview === "unavailable" ? null : preview?.nextCursor;
  const { kind, id } = source;

  useEffect(() => {
    const controller = new AbortController();
    const path = `/api/inbox/reviews/${kind}/${encodeURIComponent(id)}`;
    const query = cursor ? `?${new URLSearchParams({ cursor })}` : "";

    void fetch(`${path}${query}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as ReviewDetail)
          : ("unavailable" as const),
      )
      .then((data) => {
        if (!controller.signal.aborted) setResult({ request, preview: data });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ request, preview: "unavailable" });
      });

    return () => controller.abort();
  }, [cursor, id, kind, request]);

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container placement="center" scroll="inside">
          <Modal.Dialog className="w-full max-w-3xl rounded-xl border border-line bg-paper">
            <Modal.Header>
              <Modal.Heading>
                {preview && preview !== "unavailable"
                  ? preview.title
                  : t("preview")}
              </Modal.Heading>
              <Modal.CloseTrigger aria-label={t("close")} />
            </Modal.Header>
            <Modal.Body>
              {preview === null ? (
                <p role="status">{t("loading")}</p>
              ) : preview === "unavailable" ? (
                <p role="alert">{t("unavailable")}</p>
              ) : (
                <pre
                  key={cursor}
                  className="m-0 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-canvas p-3 text-sm"
                >
                  {preview.summary}
                </pre>
              )}
              {nextCursor || cursor ? (
                <nav
                  aria-label={t("previewPages")}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span aria-live="polite" className="text-sm text-mute">
                    {t(
                      preview && preview !== "unavailable" && !nextCursor
                        ? "previewLastPage"
                        : "previewPage",
                      { page: request.cursors.length + 1 },
                    )}
                  </span>
                  {cursor ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        setRequest({ cursors: request.cursors.slice(0, -1) })
                      }
                    >
                      {t("previewPrevious")}
                    </Button>
                  ) : null}
                  {nextCursor ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        setRequest({
                          cursors: [...request.cursors, nextCursor],
                        })
                      }
                    >
                      {t("previewNext")}
                    </Button>
                  ) : null}
                </nav>
              ) : null}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function ProposalReviews({
  page,
  filters,
  initial,
}: {
  page: Page;
  filters: {
    kind?: ReviewKind;
    projectId?: string;
    companyId?: string;
    agentId?: string;
  };
  initial?: ReviewSelector;
}) {
  const t = useTranslations("inbox.reviews");
  const common = useTranslations("common");
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<ReviewSelector | null>(
    initial ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [submitted, setSubmitted] = useState<ReviewSubmission | null>(null);
  const [reason, setReason] = useState("");
  const [outcomes, setOutcomes] = useState<
    { title: string; status: Outcome }[]
  >([]);
  const chosen = useMemo(
    () => page.items.filter((row) => selected.includes(rowKey(row))),
    [page.items, selected],
  );
  const scoped = {
    ...(filters.agentId && { agentId: filters.agentId }),
    ...(filters.projectId && { projectId: filters.projectId }),
    ...(filters.companyId && { companyId: filters.companyId }),
  };
  const href = (params: Record<string, string>) =>
    `/inbox?${new URLSearchParams(params)}#knowledge-memory`;

  const needsReason = chosen.some(({ kind }) => kind === "knowledge");

  function enabled(action: "accept" | "reject") {
    return (
      !busy &&
      submitted === null &&
      (!needsReason || reason.trim().length > 0) &&
      chosen.length > 0 &&
      chosen.length <= 50 &&
      chosen.every((row) => row.allowed.includes(action))
    );
  }

  async function submit(batch: ReviewSubmission) {
    if (busy) return;
    setBusy(true);
    setFailure(false);
    setOutcomes([]);
    try {
      const response = await fetch("/api/inbox/reviews/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: batch.body,
      });

      if (!response.ok) {
        setFailure(true);

        return;
      }
      const body = (await response.json()) as {
        results: { status: Outcome }[];
      };

      if (body.results.length !== batch.titles.length) {
        setFailure(true);

        return;
      }
      setOutcomes(
        body.results.map((result, index) => ({
          title: batch.titles[index]!,
          status: result.status,
        })),
      );
      setSubmitted(null);
      setSelected([]);
      setReason("");
      router.refresh();
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  }

  function decide(decision: "accept" | "reject") {
    if (!enabled(decision)) return;
    const trimmedReason = reason.trim();
    const items = chosen.map(({ kind, id, version }) => ({
      kind,
      id,
      expectedVersion: version,
      decision,
      requestKey: crypto.randomUUID(),
      ...(trimmedReason && { reason: trimmedReason }),
    }));
    const batch = {
      body: JSON.stringify({ items }),
      titles: chosen.map(({ title }) => title),
    };

    // A refresh can remove committed items before their response arrives.
    setSubmitted(batch);
    void submit(batch);
  }

  return (
    <section
      aria-label={t("title")}
      className="min-w-0 space-y-3"
      id="knowledge-memory"
    >
      <h2 className="m-0 text-sm font-bold text-ink">{t("title")}</h2>
      <nav aria-label={t("filter")} className="flex flex-wrap gap-3 text-sm">
        <Link
          aria-current={filters.kind === undefined ? "page" : undefined}
          href={href(scoped)}
        >
          {t("all")}
        </Link>
        {kinds.map((kind) => (
          <Link
            key={kind}
            aria-current={filters.kind === kind ? "page" : undefined}
            href={href({ ...scoped, kind })}
          >
            {t(`kind.${kind}`)}
          </Link>
        ))}
        {Object.keys(scoped).length ? (
          <Link href={href({})}>{t("clear")}</Link>
        ) : null}
      </nav>
      {page.items.length ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              isDisabled={!enabled("accept")}
              size="sm"
              variant="secondary"
              onPress={() => decide("accept")}
            >
              {t("accept")}
            </Button>
            <Button
              isDisabled={!enabled("reject")}
              size="sm"
              variant="secondary"
              onPress={() => decide("reject")}
            >
              {t("reject")}
            </Button>
            <span className="text-sm text-mute">
              {t("selected", { count: chosen.length })}
            </span>
          </div>
          {chosen.some(({ kind }) => kind !== "vault") ? (
            <label className="grid max-w-lg gap-1 text-sm">
              {t(needsReason ? "requiredReason" : "reason")}
              <Input
                disabled={busy || submitted !== null}
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          ) : null}
          <ul className="m-0 list-none divide-y divide-line rounded-xl border border-line bg-paper p-0">
            {page.items.map((row) => {
              const key = rowKey(row);

              return (
                <li key={key} className="flex flex-wrap items-center gap-3 p-3">
                  <label className="flex min-w-0 items-center gap-2">
                    <input
                      checked={selected.includes(key)}
                      disabled={busy || submitted !== null}
                      type="checkbox"
                      onChange={(event) => {
                        const checked = event.target.checked;

                        setSelected((current) =>
                          checked
                            ? [...current, key]
                            : current.filter((value) => value !== key),
                        );
                      }}
                    />
                    <span className="break-all">{row.title}</span>
                  </label>
                  <span className="ml-auto text-xs text-mute">
                    {t(`kind.${row.kind}`)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setPreview({ kind: row.kind, id: row.id })}
                  >
                    {t("preview")}
                  </Button>
                </li>
              );
            })}
          </ul>
          {page.nextCursor ? (
            <Link
              href={href({
                ...scoped,
                ...(filters.kind && { kind: filters.kind }),
                cursor: page.nextCursor,
              })}
            >
              {t("next")}
            </Link>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-mute" role="status">
          {t("empty")}
        </p>
      )}
      {failure ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert">{t("refused")}</p>
          {submitted ? (
            <Button
              isDisabled={busy}
              size="sm"
              variant="secondary"
              onPress={() => void submit(submitted)}
            >
              {common("retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {outcomes.length ? (
        <ul
          aria-label={t("results")}
          aria-live="polite"
          className="m-0 space-y-1 text-sm"
        >
          {outcomes.map((item, index) => (
            <li key={index}>
              {item.title} · {t(`outcome.${item.status}`)}
            </li>
          ))}
        </ul>
      ) : null}
      {preview ? (
        <ReviewPreview
          key={`${preview.kind}:${preview.id}`}
          close={() => setPreview(null)}
          source={preview}
        />
      ) : null}
    </section>
  );
}
