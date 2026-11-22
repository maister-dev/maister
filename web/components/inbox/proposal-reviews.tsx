"use client";

import type {
  decideProposalReview,
  getProposalReviewDetail,
} from "@/lib/queries/inbox-review-actions";
import type {
  listProposalReviews,
  ReviewFilter,
  ReviewSelector,
} from "@/lib/queries/knowledge-memory-reviews";

import { Button, Modal, Input } from "@heroui/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import {
  useAttentionReviewWatch,
  useWatchedReview,
} from "@/components/attention/attention-review-watch";
import { ProposalReviewDetails } from "@/components/inbox/proposal-review-details";

type Page = Awaited<ReturnType<typeof listProposalReviews>>;
type VisibleFilters = Omit<ReviewFilter, "limit">;
type ReviewItem = Page["items"][number];
type ReviewDetail = Awaited<ReturnType<typeof getProposalReviewDetail>>;
type ReviewReceipt = Awaited<ReturnType<typeof decideProposalReview>>;
type ReviewPosition = Pick<ReviewItem, "kind" | "id" | "createdAt">;
type ReviewNavigation = { href: string; label: "nextReview" | "next" };
type ReviewPageRequest = {
  invalidation: number;
  cursors: readonly string[];
  outcomeCursors: readonly string[];
};
type DetailFailure = "unavailable" | "retryable";
type HistoryRead = { kind: "ready"; page: Page } | { kind: DetailFailure };
type Outcome = "applied" | "rejected" | "conflict" | "unavailable" | "refused";
type ReviewSubmission = Readonly<{
  body: string;
  titles: readonly string[];
}>;
const kinds = ["vault", "brain", "knowledge"] as const;
const emptyPage: Page = { items: [], nextCursor: null, total: 0 };

function historyReadPath(filters: VisibleFilters): string | null {
  if (filters.view !== "history") return null;
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) query.set(key, value);
  }

  return `/api/inbox/reviews?${query}`;
}

function useRefreshedHistory(renderedPage: Page, filters: VisibleFilters) {
  const path = historyReadPath(filters);
  const invalidation = useAttentionReviewWatch()?.invalidation ?? 0;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    path: string;
    renderedPage: Page;
    read: HistoryRead;
  } | null>(null);

  useEffect(() => {
    if (!path || invalidation === 0) return;
    const controller = new AbortController();
    const store = (read: HistoryRead) => {
      if (!controller.signal.aborted) setResult({ path, renderedPage, read });
    };

    void fetch(path, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.ok) {
          store({ kind: "ready", page: (await response.json()) as Page });
        } else {
          store({
            kind:
              response.status === 401 || response.status === 403
                ? "unavailable"
                : "retryable",
          });
        }
      })
      .catch(() => store({ kind: "retryable" }));

    return () => controller.abort();
  }, [invalidation, path, renderedPage, retry]);

  const read =
    result?.path === path && result.renderedPage === renderedPage
      ? result.read
      : null;

  return {
    page: read ? (read.kind === "ready" ? read.page : emptyPage) : renderedPage,
    problem: read?.kind === "ready" ? null : (read?.kind ?? null),
    retry: () => setRetry((previous) => previous + 1),
  };
}

function followsReview(row: ReviewPosition, selected: ReviewPosition): boolean {
  if (row.createdAt !== selected.createdAt)
    return row.createdAt < selected.createdAt;
  if (row.kind !== selected.kind) return row.kind < selected.kind;

  return row.id < selected.id;
}

function rowKey(row: ReviewItem) {
  return JSON.stringify([row.kind, row.id, row.version]);
}

function ReviewPreview({
  source,
  close,
  inline = false,
  next,
}: {
  source: ReviewSelector;
  close: () => void;
  inline?: boolean;
  next: (review: ReviewPosition) => ReviewNavigation | null;
}) {
  const t = useTranslations("inbox.reviews");
  const common = useTranslations("common");
  const router = useRouter();
  const invalidation = useWatchedReview(source);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refreshingQueue, refreshQueue] = useTransition();
  const [command, setCommand] = useState<string | null>(null);
  const [showRevisions, setShowRevisions] = useState(false);
  const [failure, setFailure] = useState<
    "conflict" | "unavailable" | "retryable" | null
  >(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstPage = useMemo<ReviewPageRequest>(
    () => ({
      invalidation,
      cursors: [],
      outcomeCursors: [],
    }),
    [invalidation],
  );
  const [pageRequest, setRequest] = useState(firstPage);
  const [result, setResult] = useState<{
    request: ReviewPageRequest;
    navigation: ReviewPageRequest;
    preview: ReviewDetail | DetailFailure;
  } | null>(null);
  const retryPending =
    result?.navigation === pageRequest && result.preview === "retryable";
  const request = retryPending
    ? result.request
    : pageRequest.invalidation === invalidation
      ? pageRequest
      : firstPage;
  const preview = result?.request === request ? result.preview : null;
  const cursor = request.cursors.at(-1);
  const outcomeCursor = request.outcomeCursors.at(-1);
  const detail = typeof preview === "object" ? preview : null;
  const nextCursor = detail?.nextCursor;
  const { kind, id } = source;
  const path = `/api/inbox/reviews/${kind}/${encodeURIComponent(id)}`;

  useEffect(() => {
    if (inline) heading.current?.focus();
  }, [id, inline, kind]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      ...(cursor ? { cursor } : {}),
      ...(outcomeCursor ? { outcomeCursor } : {}),
    });
    const query = params.size ? `?${params}` : "";

    void fetch(`${path}${query}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as ReviewDetail)
          : response.status === 409 || response.status >= 500
            ? ("retryable" as const)
            : ("unavailable" as const),
      )
      .then((data) => {
        if (!controller.signal.aborted)
          setResult({ request, navigation: pageRequest, preview: data });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({ request, navigation: pageRequest, preview: "retryable" });
      });

    return () => controller.abort();
  }, [cursor, outcomeCursor, pageRequest, path, request]);

  function reload() {
    setFailure(null);
    setCommand(null);
    setRequest({ ...firstPage });
  }

  async function send(body: string) {
    if (submitting) return;
    setSubmitting(true);
    setCommand(body);
    setFailure(null);

    try {
      const response = await fetch(`${path}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      if (!response.ok) {
        const problem =
          response.status === 409
            ? "conflict"
            : response.status >= 500
              ? "retryable"
              : "unavailable";

        setFailure(problem);
        if (problem !== "retryable") setCommand(null);

        return;
      }

      const receipt = (await response.json()) as ReviewReceipt;

      setReceiptId(receipt.receiptId);
      setCommand(null);
      setReason("");
      setRequest({ ...firstPage });
      refreshQueue(() => router.refresh());
    } catch {
      setFailure("retryable");
    } finally {
      setSubmitting(false);
    }
  }

  function decide(decision: "accept" | "reject") {
    if (!detail?.allowed.includes(decision)) return;
    const trimmed = reason.trim();

    if ((kind === "knowledge" || decision === "reject") && !trimmed) return;
    void send(
      JSON.stringify({
        expectedVersion: detail.version,
        decision,
        requestKey: crypto.randomUUID(),
        ...(trimmed && { reason: trimmed }),
      }),
    );
  }

  const title = detail?.title ?? t("preview");
  const outcome = refreshingQueue ? null : detail?.outcome;
  const nextReview = detail && outcome ? next(detail) : null;
  const pending = detail?.domainState === "pending" && receiptId === null;
  const actionsDisabled = submitting || command !== null || failure !== null;
  const body = (
    <div className="space-y-3">
      {preview === null ? (
        <p role="status">{t("loading")}</p>
      ) : preview === "unavailable" ? (
        <p role="alert">{t("unavailable")}</p>
      ) : preview === "retryable" ? (
        <div role="alert">
          {t("readFailed")}{" "}
          <Button size="sm" variant="secondary" onPress={reload}>
            {common("retry")}
          </Button>
        </div>
      ) : detail ? (
        <ProposalReviewDetails key={cursor} proposal={detail} />
      ) : null}
      {nextCursor || cursor ? (
        <nav
          aria-label={t("previewPages")}
          className="flex flex-wrap items-center gap-2"
        >
          <span aria-live="polite" className="text-sm text-mute">
            {t(detail && !nextCursor ? "previewLastPage" : "previewPage", {
              page: request.cursors.length + 1,
            })}
          </span>
          {cursor ? (
            <Button
              size="sm"
              variant="secondary"
              onPress={() =>
                setRequest({
                  ...request,
                  cursors: request.cursors.slice(0, -1),
                })
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
                  ...request,
                  cursors: [...request.cursors, nextCursor],
                })
              }
            >
              {t("previewNext")}
            </Button>
          ) : null}
        </nav>
      ) : null}
      {pending && detail && detail.allowed.length ? (
        <div className="space-y-2">
          <label className="grid gap-1 text-sm">
            {t(kind === "knowledge" ? "requiredReason" : "decisionReason")}
            <Input
              disabled={submitting || command !== null}
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {detail.allowed.includes("accept") ? (
              <Button
                isDisabled={
                  actionsDisabled || (kind === "knowledge" && !reason.trim())
                }
                size="sm"
                onPress={() => decide("accept")}
              >
                {t("acceptReviewed")}
              </Button>
            ) : null}
            {detail.allowed.includes("reject") ? (
              <Button
                isDisabled={actionsDisabled || !reason.trim()}
                size="sm"
                variant="danger"
                onPress={() => decide("reject")}
              >
                {t("rejectReviewed")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {failure ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          {t(
            failure === "conflict"
              ? "outcome.conflict"
              : failure === "unavailable"
                ? "unavailable"
                : "refused",
          )}
          {failure === "retryable" && command ? (
            <Button
              isDisabled={submitting}
              size="sm"
              onPress={() => void send(command)}
            >
              {common("retry")}
            </Button>
          ) : failure === "conflict" ? (
            <Button size="sm" onPress={reload}>
              {t("reloadVersion")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {outcome ? (
        <div className="space-y-1" role="status">
          <p>
            {outcome.href ? (
              <Link className="underline" href={outcome.href}>
                {t(`outcomeLabel.${outcome.type}`)}
              </Link>
            ) : (
              t(`outcomeLabel.${outcome.type}`)
            )}
          </p>
          {outcome.type === "applied_vault_operation" &&
          outcome.revisions?.length ? (
            <details
              open={showRevisions}
              onToggle={(event) => setShowRevisions(event.currentTarget.open)}
            >
              <summary>
                {t("appliedRevisions", { count: outcome.revisionCount })}
              </summary>
              <ul className="list-inside list-disc break-all text-sm">
                {outcome.revisions.map((revision) => (
                  <li key={revision.revisionId}>
                    {revision.href ? (
                      <Link className="underline" href={revision.href}>
                        {revision.path}
                      </Link>
                    ) : (
                      revision.path
                    )}
                  </li>
                ))}
              </ul>
              {outcomeCursor || outcome.revisionsNextCursor ? (
                <nav
                  aria-label={t("resultPages")}
                  className="mt-2 flex flex-wrap items-center gap-2"
                >
                  {outcomeCursor ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        setRequest({
                          ...request,
                          outcomeCursors: request.outcomeCursors.slice(0, -1),
                        })
                      }
                    >
                      {t("resultPrevious")}
                    </Button>
                  ) : null}
                  {outcome.revisionsNextCursor ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        const nextCursor = outcome.revisionsNextCursor;

                        if (nextCursor)
                          setRequest({
                            ...request,
                            outcomeCursors: [
                              ...request.outcomeCursors,
                              nextCursor,
                            ],
                          });
                      }}
                    >
                      {t("resultNext")}
                    </Button>
                  ) : null}
                </nav>
              ) : null}
            </details>
          ) : null}
          {receiptId ? (
            <p className="break-all text-xs text-mute">
              {t("receipt", { id: receiptId })}
            </p>
          ) : null}
          {nextReview ? (
            <Link className="underline" href={nextReview.href}>
              {t(nextReview.label)}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (inline)
    return (
      <section
        aria-label={title}
        className="min-w-0 space-y-3 rounded-xl border border-line bg-paper p-4"
      >
        <div className="flex items-start justify-between gap-3">
          <h3
            ref={heading}
            className="break-words text-lg font-semibold"
            tabIndex={-1}
          >
            {title}
          </h3>
          <Button size="sm" variant="secondary" onPress={close}>
            {t("close")}
          </Button>
        </div>
        {body}
      </section>
    );

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
              <Modal.Heading>{title}</Modal.Heading>
              <Modal.CloseTrigger aria-label={t("close")} />
            </Modal.Header>
            <Modal.Body>{body}</Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function ProposalReviews({
  page: renderedPage,
  filters,
  initial,
  workspace = false,
}: {
  page: Page;
  filters: VisibleFilters;
  initial?: ReviewSelector;
  workspace?: boolean;
}) {
  const t = useTranslations("inbox.reviews");
  const common = useTranslations("common");
  const router = useRouter();
  const knowledge = useTranslations("knowledge");
  const {
    page,
    problem: historyProblem,
    retry: retryHistory,
  } = useRefreshedHistory(renderedPage, filters);
  const [selected, setSelected] = useState<string[]>([]);
  const [modalSelection, setModalSelection] = useState<ReviewSelector | null>(
    initial ?? null,
  );
  const preview = workspace ? (initial ?? null) : modalSelection;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [submitted, setSubmitted] = useState<ReviewSubmission | null>(null);
  const [reason, setReason] = useState("");
  const [outcomes, setOutcomes] = useState<
    { title: string; status: Outcome }[]
  >([]);
  const lastReviewed = useRef<ReviewSelector | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!workspace) return;
    if (preview === null && lastReviewed.current !== null) {
      const opener = document.getElementById(
        reviewLinkId(lastReviewed.current),
      );

      (opener ?? listHeading.current)?.focus({ preventScroll: true });
    }
    lastReviewed.current = preview;
  }, [preview, workspace]);
  const chosen = useMemo(
    () => page.items.filter((row) => selected.includes(rowKey(row))),
    [page.items, selected],
  );
  const scoped = {
    ...(filters.agentId && { agentId: filters.agentId }),
    ...(filters.projectId && { projectId: filters.projectId }),
    ...(filters.companyId && { companyId: filters.companyId }),
    ...(filters.view === "history" && { view: "history" }),
  };
  const href = (params: Record<string, string>) =>
    `${workspace ? "/knowledge/reviews" : "/inbox"}?${new URLSearchParams(params)}#knowledge-memory`;
  const selection = {
    ...scoped,
    ...(filters.kind && { kind: filters.kind }),
    ...(filters.cursor && { cursor: filters.cursor }),
  };
  const itemLink = (row: ReviewSelector) =>
    href({ ...selection, proposalKind: row.kind, proposalId: row.id });

  function nextReview(review: ReviewPosition): ReviewNavigation | null {
    if (!workspace) return null;
    const next = page.items.find((row) => followsReview(row, review));

    if (next) return { href: itemLink(next), label: "nextReview" };
    const last = page.items.at(-1);

    return page.nextCursor &&
      last?.kind === review.kind &&
      last.id === review.id
      ? { href: href({ ...selection, cursor: page.nextCursor }), label: "next" }
      : null;
  }

  const needsReason = chosen.some(({ kind }) => kind === "knowledge");

  function enabled(action: "accept" | "reject") {
    return (
      !busy &&
      submitted === null &&
      (!(needsReason || action === "reject") || reason.trim().length > 0) &&
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
      <h2
        ref={listHeading}
        className="m-0 text-sm font-bold text-ink"
        tabIndex={-1}
      >
        {t("title")}
      </h2>
      <nav
        aria-label={t("reviewState")}
        className="flex flex-wrap items-center gap-3 text-sm"
      >
        <Link
          aria-current={filters.view !== "history" ? "page" : undefined}
          href={href({ ...scoped, view: "pending" })}
        >
          {t("pending")}
        </Link>
        <Link
          aria-current={filters.view === "history" ? "page" : undefined}
          href={href({ ...scoped, view: "history" })}
        >
          {t("history")}
        </Link>
        {historyProblem ? null : (
          <span aria-live="polite" className="text-mute">
            {t("reviewCount", { count: page.total })}
          </span>
        )}
      </nav>
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
      {historyProblem ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          {t(
            historyProblem === "retryable"
              ? "historyReadFailed"
              : "historyUnavailable",
          )}
          {historyProblem === "retryable" ? (
            <Button size="sm" variant="secondary" onPress={retryHistory}>
              {common("retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        className={
          workspace && preview
            ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]"
            : ""
        }
      >
        <div
          className={
            workspace && preview ? "hidden space-y-3 lg:block" : "space-y-3"
          }
        >
          {page.items.length ? (
            <>
              {filters.view !== "history" ? (
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
              ) : null}
              {chosen.length ? (
                <label className="grid max-w-lg gap-1 text-sm">
                  {t(needsReason ? "requiredReason" : "decisionReason")}
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
                    <li
                      key={key}
                      className="flex flex-wrap items-center gap-3 p-3"
                    >
                      <label className="flex min-w-0 items-center gap-2">
                        {row.allowed.length ? (
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
                        ) : null}
                        <span className="break-all">{row.title}</span>
                      </label>
                      <span className="ml-auto text-xs text-mute">
                        {row.owner.kind === "company"
                          ? knowledge("company")
                          : row.owner.label}{" "}
                        · {t(`kind.${row.kind}`)}
                      </span>
                      {workspace ? (
                        <Link
                          aria-current={
                            preview?.kind === row.kind && preview.id === row.id
                              ? "page"
                              : undefined
                          }
                          className="underline"
                          href={itemLink(row)}
                          id={reviewLinkId(row)}
                          scroll={false}
                        >
                          {t("preview")}
                        </Link>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() =>
                            setModalSelection({ kind: row.kind, id: row.id })
                          }
                        >
                          {t("preview")}
                        </Button>
                      )}
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
          ) : !historyProblem ? (
            <p className="text-sm text-mute" role="status">
              {t(filters.view === "history" ? "emptyHistory" : "empty")}
            </p>
          ) : null}
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
        </div>
        {preview ? (
          <ReviewPreview
            key={`${preview.kind}:${preview.id}`}
            close={() => {
              if (!workspace) setModalSelection(null);
              if (initial) router.replace(href(selection), { scroll: false });
            }}
            inline={workspace}
            next={nextReview}
            source={preview}
          />
        ) : null}
      </div>
    </section>
  );
}

function reviewLinkId({ id, kind }: ReviewSelector) {
  return `review-link-${kind}-${encodeURIComponent(id)}`;
}
