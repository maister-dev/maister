export const GITHUB_REPOSITORY = "kanischev/mAIster";
export const GITHUB_URL = `https://github.com/${GITHUB_REPOSITORY}`;
export const GITHUB_PROFILE = "kanischev";
export const GITHUB_PROFILE_URL = `https://github.com/${GITHUB_PROFILE}`;
export const TELEGRAM_PROFILE = "HealthyWealthyAndWise";
export const TELEGRAM_URL = `https://t.me/${TELEGRAM_PROFILE}`;
export const DEFAULT_DOCS_URL = "https://docs.imaister.dev";

export function docsUrl(): string {
  return process.env.NEXT_PUBLIC_DOCS_URL ?? DEFAULT_DOCS_URL;
}

export function siteUrl(): URL {
  return new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001");
}
