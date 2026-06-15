import { getTranslations } from "next-intl/server";

export default async function StudioOverviewPage() {
  const t = await getTranslations("studio");

  return <main aria-label={t("title")}>{t("title")}</main>;
}
