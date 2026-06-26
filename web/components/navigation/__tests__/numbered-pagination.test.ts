import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildNumberedPaginationItems,
  NumberedPagination,
} from "@/components/navigation/numbered-pagination";

const LABELS = {
  ariaLabel: "Runs pages",
  next: "Next",
  page: "Page {page}",
  previous: "Previous",
};

describe("NumberedPagination", () => {
  it("keeps first, current neighbors, and last page visible", () => {
    expect(
      buildNumberedPaginationItems({ currentPage: 5, pageCount: 10 }),
    ).toEqual([1, "ellipsis", 4, 5, 6, "ellipsis", 10]);
  });

  it("renders numbered links plus previous and next targets", () => {
    const html = renderToStaticMarkup(
      createElement(NumberedPagination, {
        currentPage: 5,
        hrefForPage: (page: number) => `/runs?page=${page}`,
        labels: LABELS,
        pageCount: 10,
      }),
    );

    expect(html).toContain('aria-label="Runs pages"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('data-testid="pagination-page-5"');
    expect(html).toContain('href="/runs?page=4"');
    expect(html).toContain('href="/runs?page=6"');
    expect(html).toContain('href="/runs?page=10"');
    expect(html).not.toContain('data-testid="pagination-page-2"');
  });
});
