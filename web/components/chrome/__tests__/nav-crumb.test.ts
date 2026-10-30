import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({ state: { pathname: "/projects" } }));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));

import { NavCrumb } from "@/components/chrome/nav-crumb";

const labels = { home: "Стол", projects: "Проекты" };
const hrefs = { home: "/", projects: "/projects" };

function render(): string {
  return renderToStaticMarkup(
    createElement(NavCrumb, {
      ariaLabel: "Путь по разделам",
      fallback: "Стол",
      hrefs,
      labels,
    }),
  );
}

beforeEach(() => {
  state.pathname = "/projects";
});

describe("NavCrumb", () => {
  it("renders one translated, navigable project crumb", () => {
    const html = render();

    expect(html.match(/Проекты/g)).toHaveLength(1);
    expect(html).toContain('href="/projects"');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("~/projects");
  });

  it("links nested project routes back to the project list", () => {
    state.pathname = "/projects/fuse/tasks/2";

    const html = render();

    expect(html).toContain('href="/projects"');
    expect(html).not.toContain('aria-current="page"');
  });
});
