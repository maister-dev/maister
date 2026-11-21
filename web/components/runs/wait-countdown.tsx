"use client";

import type { ReactElement } from "react";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export function WaitCountdown({
  deadline,
}: {
  deadline: string;
}): ReactElement {
  const t = useTranslations("flowWait");
  const [now, setNow] = useState(Date.now);
  const end = Date.parse(deadline);
  const remaining = Math.max(0, Math.ceil((end - now) / 1000));

  useEffect(() => {
    const timer = setInterval(() => {
      const current = Date.now();

      setNow(current);
      if (current >= end) clearInterval(timer);
    }, 1000);

    return () => clearInterval(timer);
  }, [end]);

  return (
    <span>
      {remaining > 0
        ? t("secondsRemaining", { seconds: remaining })
        : t("overdue")}
    </span>
  );
}
