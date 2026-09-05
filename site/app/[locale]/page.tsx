import type { Metadata } from "next";
import type { ReactElement } from "react";

import Link from "next/link";
import { notFound } from "next/navigation";

import { GitHubRepoWidget } from "@/components/github-repo-widget";
import { HeaderRepositoryControl } from "@/components/header-repository-control";
import { InstallCommand } from "@/components/install-command";
import { LocaleSwitch } from "@/components/locale-switch";
import { Logo } from "@/components/logo";
import { ProductTour } from "@/components/product-tour";
import { GitHubIcon, TelegramIcon } from "@/components/social-icons";
import { ThemeToggle } from "@/components/theme-toggle";
import { getContent } from "@/lib/content";
import { isLocale } from "@/lib/locale";
import {
  docsUrl,
  GITHUB_PLUGINS_URL,
  GITHUB_PROFILE_URL,
  GITHUB_URL,
  QUICKSTART_SCRIPT_URL,
  siteUrl,
  TELEGRAM_URL,
} from "@/lib/site-config";
import { tourImageSrc } from "@/lib/tour-assets";
import { SpineGraph } from "../../../web/components/auth/spine-graph";

type PageProps = {
  params: Promise<{ locale: string }>;
};

function localizedDocsUrl(locale: "en" | "ru", page = ""): string {
  const base = docsUrl().replace(/\/$/, "");
  const localePath = locale === "ru" ? "/ru" : "";
  const pagePath = page ? `/${page}` : "";

  return `${base}${localePath}${pagePath}`;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale } = await params;

  if (!isLocale(locale)) notFound();
  const content = getContent(locale);

  return {
    metadataBase: siteUrl(),
    title: content.meta.title,
    description: content.meta.description,
    alternates: {
      canonical: `/${locale}`,
      languages: { en: "/en", ru: "/ru" },
    },
    openGraph: {
      type: "website",
      title: content.meta.title,
      description: content.meta.description,
      locale: locale === "ru" ? "ru_RU" : "en_US",
      images: [
        {
          alt: "MAIster governed delivery map",
          height: 864,
          url: "/governed-delivery-map.png",
          width: 1536,
        },
      ],
    },
  };
}

export default async function LandingPage({
  params,
}: PageProps): Promise<ReactElement> {
  const { locale } = await params;

  if (!isLocale(locale)) notFound();
  const content = getContent(locale);
  const docsHome = localizedDocsUrl(locale);
  const quickstart = localizedDocsUrl(locale, "quickstart");
  const tourShots = content.tour.shots.map((shot) => ({
    ...shot,
    darkSrc: tourImageSrc(shot.id, locale, "dark"),
    lightSrc: tourImageSrc(shot.id, locale, "light"),
  }));
  const footerColumns = [
    {
      links: [
        { href: "#why", label: content.footer.product.why },
        { href: "#product", label: content.footer.product.tour },
        { href: "#workflow", label: content.footer.product.workflow },
        { href: "#compare", label: content.footer.product.compare },
      ],
      title: content.footer.product.title,
    },
    {
      links: [
        { href: quickstart, label: content.footer.docs.gettingStarted },
        { href: docsHome, label: content.footer.docs.home },
        {
          href: localizedDocsUrl(locale, "guides/human-in-the-loop"),
          label: content.footer.docs.hitl,
        },
        {
          href: localizedDocsUrl(locale, "operations/costs-and-budgets"),
          label: content.footer.docs.costs,
        },
      ],
      title: content.footer.docs.title,
    },
    {
      links: [
        {
          href: localizedDocsUrl(locale, "concepts/project-brain-and-agents"),
          label: content.footer.platform.agents,
        },
        {
          href: localizedDocsUrl(locale, "concepts/evidence-and-review"),
          label: content.footer.platform.evidence,
        },
        {
          href: localizedDocsUrl(locale, "reference/flow-manifest"),
          label: content.footer.platform.flows,
        },
        {
          href: localizedDocsUrl(locale, "concepts/recursive-agent-harness"),
          label: content.footer.platform.rah,
        },
      ],
      title: content.footer.platform.title,
    },
    {
      links: [
        { href: GITHUB_URL, label: `${content.footer.project.source} ↗` },
        {
          href: `${GITHUB_URL}/blob/master/CONTRIBUTING.md`,
          label: content.footer.project.contributing,
        },
        { href: `${GITHUB_URL}/issues`, label: content.footer.project.issues },
        {
          href: `${GITHUB_URL}/discussions`,
          label: content.footer.project.discussions,
        },
        {
          href: `${GITHUB_URL}/blob/master/SECURITY.md`,
          label: content.footer.project.security,
        },
        {
          href: `${GITHUB_URL}/blob/master/CODE_OF_CONDUCT.md`,
          label: content.footer.project.conduct,
        },
        {
          href: `${GITHUB_URL}/blob/master/LICENSE`,
          label: content.footer.project.license,
        },
      ],
      title: content.footer.project.title,
    },
  ] as const;

  return (
    <>
      <a className="skip-link" href="#content">
        {content.controls.skip}
      </a>

      <header className="site-header">
        <div className="header-inner">
          <Link aria-label="MAIster" href={`/${locale}`}>
            <Logo />
          </Link>

          <nav aria-label="Primary" className="primary-nav">
            <a href="#why">{content.nav.why}</a>
            <a href="#product">{content.nav.product}</a>
            <a href="#workflow">{content.nav.workflow}</a>
            <a href="#controls">{content.nav.controls}</a>
            <a href="#packages">{content.nav.packages}</a>
            <a href="#compare">{content.nav.compare}</a>
            <a href={docsHome}>{content.nav.docs}</a>
          </nav>

          <div className="header-actions">
            <LocaleSwitch current={locale} label={content.controls.language} />
            <ThemeToggle
              darkLabel={content.controls.themeDark}
              darkText={content.controls.themeDarkShort}
              lightLabel={content.controls.themeLight}
              lightText={content.controls.themeLightShort}
            />
            <HeaderRepositoryControl
              locale={locale}
              starsLabel={content.repository.stars}
            />
          </div>
        </div>
      </header>

      <main id="content">
        <section className="hero section-shell" id="top">
          <div className="hero-copy reveal">
            <p className="eyebrow">{content.hero.eyebrow}</p>
            <h1>
              {content.hero.title} <em>{content.hero.accent}</em>
            </h1>
            <p className="hero-body">{content.hero.body}</p>
            <div className="cta-row">
              <a className="button button-primary" href={quickstart}>
                {content.hero.primary} <span aria-hidden="true">→</span>
              </a>
              <a className="button button-secondary" href={docsHome}>
                {content.hero.secondary} <span aria-hidden="true">↗</span>
              </a>
            </div>
            <div className="hero-install">
              <span className="hero-install-label">
                {content.hero.install.label}
              </span>
              <InstallCommand
                command={content.hero.install.command}
                copiedLabel={content.hero.install.copied}
                copyLabel={content.hero.install.copy}
              />
              <p className="hero-install-hint">
                {content.hero.install.hint}{" "}
                <a href={quickstart}>{content.hero.install.hintLink} →</a>{" "}
                ·{" "}
                <a href={QUICKSTART_SCRIPT_URL}>
                  {content.hero.install.scriptLink} ↗
                </a>
              </p>
            </div>
          </div>

          <div className="hero-visual reveal reveal-delay">
            <SpineGraph />
          </div>

          <dl className="scope-rail">
            {content.hero.rail.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="section-shell section-block" id="why">
          <div className="section-heading split-heading">
            <div>
              <p className="eyebrow">{content.problem.eyebrow}</p>
              <h2>
                {content.problem.title} <em>{content.problem.accent}</em>
              </h2>
            </div>
            <p>{content.problem.body}</p>
          </div>

          <div className="change-grid">
            {content.problem.items.map((item, index) => (
              <article key={item.after} className="change-card">
                <div className="change-state-row">
                  <span className="card-index">0{index + 1}</span>
                  <span className="change-state is-before">{item.before}</span>
                  <span aria-hidden="true" className="change-arrow">
                    →
                  </span>
                </div>
                <h3>{item.after}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="tour-section" id="product">
          <div className="section-shell section-block">
            <div className="section-heading split-heading">
              <div>
                <p className="eyebrow">{content.tour.eyebrow}</p>
                <h2>{content.tour.title}</h2>
              </div>
              <p>{content.tour.body}</p>
            </div>
            <ProductTour shots={tourShots} />
          </div>
        </section>

        <section className="workflow-section" id="workflow">
          <div className="section-shell section-block">
            <div className="section-heading centered-heading">
              <p className="eyebrow">{content.workflow.eyebrow}</p>
              <h2>{content.workflow.title}</h2>
              <p>{content.workflow.body}</p>
            </div>

            <ol className="workflow-list">
              {content.workflow.nodes.map((node, index) => (
                <li key={node.label}>
                  <span className="workflow-dot">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <strong>{node.label}</strong>
                  <small>{node.detail}</small>
                </li>
              ))}
            </ol>
            <p className="workflow-note">{content.workflow.note}</p>
          </div>
        </section>

        <section className="section-shell section-block" id="controls">
          <div className="section-heading split-heading">
            <div>
              <p className="eyebrow">{content.controlsSection.eyebrow}</p>
              <h2>{content.controlsSection.title}</h2>
            </div>
            <p>{content.controlsSection.body}</p>
          </div>

          <div className="feature-grid">
            {content.controlsSection.features.map((feature) => (
              <article key={feature.number} className="feature-card">
                <span className="feature-number">{feature.number}</span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
                <span className="feature-meta">{feature.meta}</span>
              </article>
            ))}
          </div>

          <div className="autonomy-strip">
            <div>
              <p className="eyebrow">{content.autonomy.eyebrow}</p>
              <h3>{content.autonomy.title}</h3>
              <p>{content.autonomy.body}</p>
              <a
                href={localizedDocsUrl(locale, "concepts/path-to-agentization")}
              >
                {content.autonomy.link} ↗
              </a>
            </div>
            <div
              aria-label={content.autonomy.eyebrow}
              className="agentization-equation"
            >
              {content.autonomy.levels.map((level, index) => (
                <div
                  key={level.artifact}
                  className="agentization-equation-step"
                >
                  <strong>{level.artifact}</strong>
                  <small>{level.mode}</small>
                  {index < content.autonomy.levels.length - 1 ? (
                    <span aria-hidden="true">→</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="packages-section" id="packages">
          <div className="section-shell section-block">
            <div className="section-heading split-heading">
              <div>
                <p className="eyebrow">{content.packages.eyebrow}</p>
                <h2>{content.packages.title}</h2>
              </div>
              <p>{content.packages.body}</p>
            </div>

            <div className="package-grid">
              {content.packages.items.map((item) => (
                <article key={item.id} className="package-card">
                  <code>{item.id}</code>
                  <h3>{item.name}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>
            <div className="packages-cta">
              <a
                aria-label={content.packages.link.ariaLabel}
                className="button button-secondary"
                href={GITHUB_PLUGINS_URL}
                rel="noreferrer"
                target="_blank"
              >
                {content.packages.link.label} ↗
              </a>
            </div>
          </div>
        </section>

        <section className="section-shell section-block" id="compare">
          <div className="section-heading split-heading">
            <div>
              <p className="eyebrow">{content.compare.eyebrow}</p>
              <h2>{content.compare.title}</h2>
            </div>
            <p>{content.compare.body}</p>
          </div>

          <div className="compare-table-wrap">
            <table className="compare-table">
              <thead>
                <tr>
                  <th scope="col">{content.compare.columns.criterion}</th>
                  <th scope="col">{content.compare.columns.kanban}</th>
                  <th scope="col">{content.compare.columns.runners}</th>
                  <th className="is-maister" scope="col">
                    {content.compare.columns.maister}
                  </th>
                </tr>
              </thead>
              <tbody>
                {content.compare.rows.map((row) => (
                  <tr key={row.criterion}>
                    <th scope="row">{row.criterion}</th>
                    <td>{row.kanban}</td>
                    <td>{row.runners}</td>
                    <td className="is-maister">{row.maister}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="compare-note">{content.compare.note}</p>
        </section>

        <section className="repository-section" id="repository">
          <div className="section-shell repository-layout">
            <div className="repository-copy">
              <p className="eyebrow">{content.repository.eyebrow}</p>
              <h2>{content.repository.title}</h2>
              <p>{content.repository.body}</p>
              <a
                aria-label={content.repository.open.ariaLabel}
                className="button button-primary"
                href={GITHUB_URL}
              >
                {content.repository.open.label} ↗
              </a>
              <nav
                aria-label={content.footer.project.title}
                className="repository-links"
              >
                <a href={`${GITHUB_URL}/discussions`}>
                  {content.repository.links.discussions}
                </a>
                <a href={`${GITHUB_URL}/issues`}>
                  {content.repository.links.issues}
                </a>
                <a href={`${GITHUB_URL}/blob/master/CONTRIBUTING.md`}>
                  {content.repository.links.contributing}
                </a>
              </nav>
              <aside className="dogfood-note">
                <span>{content.repository.dogfood.label}</span>
                <strong>{content.repository.dogfood.title}</strong>
                <p>{content.repository.dogfood.body}</p>
              </aside>
            </div>
            <GitHubRepoWidget
              labels={{
                branch: content.repository.branch,
                connected: content.repository.connected,
                error: content.repository.error,
                forks: content.repository.forks,
                issues: content.repository.issues,
                license: content.repository.license,
                loading: content.repository.loading,
                retry: content.repository.retry,
                stars: content.repository.stars,
                updated: content.repository.updated,
              }}
              locale={locale}
            />
          </div>
        </section>

        <section className="services-section" id="services">
          <div className="section-shell section-block">
            <div className="section-heading split-heading">
              <div>
                <p className="eyebrow">{content.services.eyebrow}</p>
                <h2>{content.services.title}</h2>
              </div>
              <p>{content.services.body}</p>
            </div>

            <div className="offer-grid">
              {content.services.offers.map((offer) => (
                <article key={offer.name} className="offer-card">
                  <span>{offer.duration}</span>
                  <h3>{offer.name}</h3>
                  <p>{offer.body}</p>
                </article>
              ))}
            </div>
            <div className="services-cta">
              <a
                aria-label={content.services.cta.ariaLabel}
                className="button button-primary"
                href={TELEGRAM_URL}
                rel="noreferrer"
                target="_blank"
              >
                {content.services.cta.label} ↗
              </a>
              <p className="services-note">{content.services.note}</p>
            </div>
          </div>
        </section>

        <section className="section-shell section-block faq-section" id="faq">
          <div className="section-heading">
            <p className="eyebrow">{content.faq.eyebrow}</p>
            <h2>{content.faq.title}</h2>
          </div>
          <div className="faq-list">
            {content.faq.items.map((item) => (
              <details key={item.question} className="faq-item">
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="section-shell final-cta">
          <p className="eyebrow">{content.final.eyebrow}</p>
          <h2>{content.final.title}</h2>
          <p>{content.final.body}</p>
          <div className="cta-row">
            <a className="button button-primary" href={quickstart}>
              {content.final.primary} →
            </a>
            <a className="button button-secondary" href={GITHUB_URL}>
              {content.final.secondary} ↗
            </a>
          </div>
        </section>
      </main>

      <footer className="site-footer" id="footer">
        <div className="section-shell footer-inner">
          <div className="footer-grid">
            <div className="footer-brand">
              <Logo />
              <span className="footer-motto">{content.footer.motto}</span>
              <p>
                {content.footer.tagline}{" "}
                <strong>{content.footer.taglineAccent}</strong>
              </p>
            </div>

            {footerColumns.map((column) => (
              <nav
                aria-label={column.title}
                className="footer-column"
                key={column.title}
              >
                <h2>{column.title}</h2>
                <ul>
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <a href={link.href}>{link.label}</a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>

          <div className="footer-bottom">
            <nav
              aria-label={content.footer.contacts.title}
              className="footer-contacts"
            >
              <a
                aria-label={content.footer.contacts.github}
                href={GITHUB_PROFILE_URL}
                rel="noreferrer"
                target="_blank"
              >
                <GitHubIcon />
              </a>
              <a
                aria-label={content.footer.contacts.telegram}
                href={TELEGRAM_URL}
                rel="noreferrer"
                target="_blank"
              >
                <TelegramIcon />
              </a>
            </nav>
            <span>{content.footer.copyright}</span>
            <span className="footer-status">{content.footer.status}</span>
          </div>
        </div>
      </footer>
    </>
  );
}
