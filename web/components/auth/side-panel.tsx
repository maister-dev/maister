import type { PlatformStatus } from "@/types/platform-status";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

import { SpineGraph } from "@/components/auth/spine-graph";
import { PlatformStatusDot } from "@/components/chrome/platform-status";

export async function SidePanel({
  platformStatus,
}: {
  platformStatus: PlatformStatus;
}): Promise<ReactElement> {
  const t = await getTranslations("side");
  const motto = (await getTranslations())("footer.motto");
  const spineEye =
    platformStatus.kind === "ready"
      ? t("spineEyeReady")
      : t("spineEyeUnavailable");

  return (
    <div className="relative z-[2] w-full max-w-[680px]">
      <div className="mb-[18px] inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-mute">
        <PlatformStatusDot status={platformStatus} />
        {spineEye}
      </div>

      <h3 className="m-0 mb-3 max-w-[25ch] text-[34px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
        <em className="not-italic font-semibold text-amber [background:linear-gradient(180deg,transparent_70%,var(--amber-soft)_70%)] [margin:0_-3px] [padding:0_3px]">
          {t("spineH3em")}
        </em>
        <br />
        {t("spineH3rest")}
      </h3>

      <p className="m-0 mb-[22px] max-w-[46ch] text-[15px] leading-[1.55] text-mute">
        {t("spineSub")}
      </p>

      <SpineGraph />

      <div className="mt-3.5 flex flex-wrap gap-[18px] font-mono text-[10.5px] tracking-[0.04em] text-mute">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-amber" />
          {t("l1")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-accent-3" />
          {t("l2")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-accent-4" />
          {t("l3")}
        </span>
      </div>

      <div className="mt-9 inline-flex items-center gap-2 rounded-full border border-line bg-ivory px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-mute">
        <span className="h-[5px] w-[5px] rounded-full bg-amber" />
        {motto}
      </div>
    </div>
  );
}
