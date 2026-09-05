import type { TourShotId } from "@/lib/content";
import type { Locale } from "@/lib/locale";

export type TourTheme = "light" | "dark";

type TourVariant = `${Locale}-${TourTheme}`;

// Files present under site/public/tour as `<shot>-<locale>-<theme>.jpg`.
// Register a variant here after adding the file; a missing variant falls back
// through the order in `tourImageSrc`, so a locale or theme without its own
// capture still shows a real screen.
const AVAILABLE_VARIANTS: Record<TourShotId, ReadonlyArray<TourVariant>> = {
  portfolio: ["en-light", "en-dark", "ru-light", "ru-dark"],
  board: ["en-light", "en-dark", "ru-light", "ru-dark"],
  run: ["en-light", "en-dark", "ru-light", "ru-dark"],
  inbox: ["en-light", "en-dark", "ru-light", "ru-dark"],
  review: ["en-light", "en-dark", "ru-light", "ru-dark"],
};

export const TOUR_IMAGE_WIDTH = 1600;
export const TOUR_IMAGE_HEIGHT = 1000;

export function tourImageSrc(
  shot: TourShotId,
  locale: Locale,
  theme: TourTheme,
): string {
  const preference: ReadonlyArray<TourVariant> = [
    `${locale}-${theme}`,
    `${locale}-light`,
    `en-${theme}`,
    "en-light",
    "ru-light",
  ];
  const available = AVAILABLE_VARIANTS[shot];
  const variant =
    preference.find((candidate) => available.includes(candidate)) ??
    available[0];

  return `/tour/${shot}-${variant}.jpg`;
}
