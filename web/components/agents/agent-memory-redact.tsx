"use client";

import { Button, Input, Modal } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { vaultRequest } from "./agent-memory-requests";

export function AgentMemoryRedact({
  revisionId,
  onRedacted,
}: {
  revisionId: string;
  onRedacted: () => void;
}) {
  const t = useTranslations("agentVault");
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit() {
    if (!requestKey || !reason.trim()) return;
    setBusy(true);
    setFailed(false);
    try {
      await vaultRequest(
        `/api/agent-memory/revisions/${encodeURIComponent(revisionId)}/redact`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason, requestKey }),
        },
      );
      setRequestKey(null);
      onRedacted();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onPress={() => {
          setRequestKey(crypto.randomUUID());
          setReason("");
          setFailed(false);
        }}
      >
        {t("redact")}
      </Button>
      <Modal
        isOpen={requestKey !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRequestKey(null);
        }}
      >
        <Modal.Backdrop isDismissable={!busy} isKeyboardDismissDisabled={busy}>
          <Modal.Container placement="center">
            <Modal.Dialog className="w-full max-w-xl rounded-xl border border-line bg-paper">
              <Modal.Header>
                <Modal.Heading>{t("redact")}</Modal.Heading>
                <Modal.CloseTrigger
                  aria-label={t("cancel")}
                  isDisabled={busy}
                />
              </Modal.Header>
              <Modal.Body>
                <p>{t("redactConfirm")}</p>
                <label className="grid gap-1">
                  {t("redactReason")}
                  <Input
                    disabled={busy}
                    maxLength={1024}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
                {failed ? <p role="alert">{t("loadError")}</p> : null}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  isDisabled={busy || !reason.trim()}
                  variant="danger"
                  onPress={() => void submit()}
                >
                  {t("redact")}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
