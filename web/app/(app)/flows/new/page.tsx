import type { Metadata } from "next";
import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { requireActiveSession } from "@/lib/authz";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("flows");

  return { title: t("newTitle") };
}

// Authored-catalog drafts remain readable at their detail route, but creating a
// new Flow now has one canonical path: the git-backed Studio package wizard.
// The query opens that wizard directly after the redirect.
export default async function NewFlowPage(): Promise<ReactElement> {
  await requireActiveSession();
  redirect("/studio/packages?create=flow");
}
