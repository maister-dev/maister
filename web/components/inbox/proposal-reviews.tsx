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
  const [preview, setPreview] = useState<ReviewDetail | "unavailable" | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();
    const { kind, id } = source;

    void fetch(`/api/inbox/reviews/${kind}/${encodeURIComponent(id)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as ReviewDetail)
          : ("unavailable" as const),
      )
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview("unavailable");
      });

    return () => controller.abort();
  }, [source]);

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
                <pre className="m-0 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-canvas p-3 text-sm">
                  {preview.summary}
                </pre>
              )}
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
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<ReviewSelector | null>(
    initial ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
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
      (!needsReason || reason.trim().length > 0) &&
      chosen.length > 0 &&
      chosen.length <= 50 &&
      chosen.every((row) => row.allowed.includes(action))
    );
  }

  async function decide(decision: "accept" | "reject") {
    if (!enabled(decision)) return;
    setBusy(true);
    setFailure(false);
    setOutcomes([]);
    try {
      const items = chosen.map(({ kind, id, version }) => ({
        kind,
        id,
        expectedVersion: version,
        decision,
        requestKey: crypto.randomUUID(),
        ...(reason.trim() && { reason: reason.trim() }),
      }));
      const response = await fetch("/api/inbox/reviews/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!response.ok) {
        setFailure(true);
        return;
      }
      const body = (await response.json()) as {
        results: { status: Outcome }[];
      };

      setOutcomes(
        body.results.map((result, index) => ({
          title: chosen[index]!.title,
          status: result.status,
        })),
      );
      setSelected([]);
      setReason("");
      router.refresh();
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="knowledge-memory"
      aria-label={t("title")}
      className="min-w-0 space-y-3"
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
            aria-current={filters.kind === kind ? "page" : undefined}
            key={kind}
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
              size="sm"
              variant="secondary"
              isDisabled={!enabled("accept")}
              onPress={() => void decide("accept")}
            >
              {t("accept")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={!enabled("reject")}
              onPress={() => void decide("reject")}
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
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={2000}
              />
            </label>
          ) : null}
          <ul className="m-0 list-none divide-y divide-line rounded-xl border border-line bg-paper p-0">
            {page.items.map((row) => {
              const key = rowKey(row);

              return (
                <li className="flex flex-wrap items-center gap-3 p-3" key={key}>
                  <label className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.includes(key)}
                      disabled={busy}
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
        <p role="status" className="text-sm text-mute">
          {t("empty")}
        </p>
      )}
      {failure ? <p role="alert">{t("refused")}</p> : null}
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
          source={preview}
          close={() => setPreview(null)}
        />
      ) : null}
    </section>
  );
}
