import type { Metadata } from "next";
import type { ReactElement } from "react";

import Link from "next/link";
import { notFound } from "next/navigation";

import { CollaborationActorGlyph, CollaborationMap } from "@/components/collaboration-map";
import { GitHubRepoWidget } from "@/components/github-repo-widget";
import { HeaderRepositoryControl } from "@/components/header-repository-control";
import { LocaleSwitch } from "@/components/locale-switch";
import { Logo } from "@/components/logo";
import { GitHubIcon, TelegramIcon } from "@/components/social-icons";
import { ThemeToggle } from "@/components/theme-toggle";
import { getContent } from "@/lib/content";
import { isLocale } from "@/lib/locale";
import {
  docsUrl,
  GITHUB_PROFILE_URL,
  GITHUB_REPOSITORY,
  GITHUB_URL,
  siteUrl,
  TELEGRAM_URL,
} from "@/lib/site-config";
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

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
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

export default async function LandingPage({ params }: PageProps): Promise<ReactElement> {
  const { locale } = await params;

  if (!isLocale(locale)) notFound();
  const content = getContent(locale);
  const docsHome = localizedDocsUrl(locale);
  const quickstart = localizedDocsUrl(locale, "quickstart");
  const footerColumns = [
    {
      links: [
        { href: "#positioning", label: content.footer.product.overview },
        { href: "#workflow", label: content.footer.product.workflow },
        { href: "#collaboration", label: content.footer.product.collaboration },
        { href: "#architecture", label: content.footer.product.architecture },
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
        { href: `${GITHUB_URL}/discussions`, label: content.footer.project.discussions },
        {
          href: `${GITHUB_URL}/blob/master/SECURITY.md`,
          label: content.footer.project.security,
        },
        {
          href: `${GITHUB_URL}/blob/master/CODE_OF_CONDUCT.md`,
          label: content.footer.project.conduct,
        },
        { href: `${GITHUB_URL}/blob/master/LICENSE`, label: content.footer.project.license },
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
            <a href="#positioning">{content.nav.product}</a>
            <a href="#workflow">{content.nav.workflow}</a>
            <a href="#agentization">{content.nav.agentization}</a>
            <a href="#controls">{content.nav.controls}</a>
            <a href="#architecture">{content.nav.architecture}</a>
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
              errorLabel={content.repository.error}
              loadingLabel={content.repository.loading}
              locale={locale}
              starsLabel={content.repository.stars}
            />
          </div>
        </div>
      </header>

      <main id="content">
        <section className="hero section-shell">
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
              <a className="hero-repository-meta" href={GITHUB_URL}>
                github.com/{GITHUB_REPOSITORY} · MIT
              </a>
            </div>
          </div>

          <div className="hero-visual reveal reveal-delay">
            <SpineGraph />
          </div>

          <dl className="scope-rail">
            {content.hero.scope.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="positioning-section" id="positioning">
          <div className="section-shell section-block">
            <div className="section-heading split-heading positioning-heading">
              <div>
                <p className="eyebrow">{content.positioning.eyebrow}</p>
                <h2>{content.positioning.title}</h2>
              </div>
              <p>{content.positioning.body}</p>
            </div>

            <div className="positioning-grid">
              {content.positioning.items.map((item) => (
                <article key={item.label}>
                  <span>{item.label}</span>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              ))}
            </div>

            <aside className="dogfood-note">
              <span>{content.positioning.dogfood.label}</span>
              <strong>{content.positioning.dogfood.title}</strong>
              <p>{content.positioning.dogfood.body}</p>
            </aside>
          </div>
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
                  <span aria-hidden="true" className="change-arrow">→</span>
                </div>
                <h3>{item.after}</h3>
                <p>{item.body}</p>
              </article>
            ))}
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
                  <span className="workflow-dot">{String(index + 1).padStart(2, "0")}</span>
                  <strong>{node.label}</strong>
                  <small>{node.detail}</small>
                </li>
              ))}
            </ol>
            <p className="workflow-note">{content.workflow.note}</p>
          </div>
        </section>

        <section className="agentization-section" id="agentization">
          <div className="section-shell agentization-shell">
            <div className="agentization-content">
              <div className="agentization-intro">
                <p className="eyebrow">{content.autonomy.eyebrow}</p>
                <h2>{content.autonomy.title}</h2>
                <p>{content.autonomy.body}</p>
              </div>

              <div className="agentization-equation" aria-label={content.autonomy.eyebrow}>
                {content.autonomy.levels.map((level, index) => (
                  <div key={level.artifact} className="agentization-equation-step">
                    <strong>{level.artifact}</strong>
                    <small>{level.mode}</small>
                    {index < content.autonomy.levels.length - 1 ? (
                      <span aria-hidden="true">→</span>
                    ) : null}
                  </div>
                ))}
              </div>

              <ol className="agentization-levels">
                {content.autonomy.levels.map((level, index) => (
                  <li key={level.artifact}>
                    <div className="agentization-level-head">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{level.artifact}</strong>
                    </div>
                    <p className="agentization-mode">{level.mode}</p>
                    <h3>{level.title}</h3>
                    <p>{level.body}</p>
                    <dl>
                      <div>
                        <dt>{content.autonomy.humanLabel}</dt>
                        <dd>{level.human}</dd>
                      </div>
                      <div>
                        <dt>{content.autonomy.systemLabel}</dt>
                        <dd>{level.system}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ol>

              <div className="built-in-agents">
                <div className="built-in-agents-intro">
                  <p className="eyebrow">{content.autonomy.builtIns.eyebrow}</p>
                  <h3>{content.autonomy.builtIns.title}</h3>
                  <p>{content.autonomy.builtIns.body}</p>
                </div>
                <div className="built-in-agent-grid">
                  {content.autonomy.builtIns.agents.map((agent) => (
                    <article key={agent.id}>
                      <code>{agent.id}</code>
                      <h4>{agent.name}</h4>
                      <span>{agent.trigger}</span>
                      <p>{agent.body}</p>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="collaboration-section" id="collaboration">
          <div className="section-shell section-block">
            <div className="collaboration-heading">
              <p className="eyebrow">{content.collaboration.eyebrow}</p>
              <h2>
                <em>{content.collaboration.title}</em>
                <br />
                <span>{content.collaboration.accent}</span>
              </h2>
              <p>{content.collaboration.body}</p>
            </div>

            <div className="collaboration-grid">
              <CollaborationMap
                agentLabel={content.collaboration.agentLabel}
                ariaLabel={content.collaboration.diagramLabel}
                humanLabel={content.collaboration.humanLabel}
              />

              <div className="collaboration-cards">
                {content.collaboration.modes.map((mode) => (
                  <article className="collaboration-card" key={mode.title}>
                    <div className="collaboration-pair">
                      <CollaborationActorGlyph actor={mode.from} />
                      <span aria-hidden="true">{mode.direction}</span>
                      <CollaborationActorGlyph actor={mode.to} />
                    </div>
                    <div className="collaboration-card-copy">
                      <h3>{mode.title}</h3>
                      <p>{mode.body}</p>
                      <span>{mode.meta}</span>
                    </div>
                  </article>
                ))}
              </div>
            </div>
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

          <div className="capability-showcases">
            {content.controlsSection.spotlights.map((spotlight, index) => (
              <article
                key={spotlight.title}
                className={`capability-showcase accent-${(index % 4) + 1}`}
              >
                <div className="capability-copy">
                  <span className="capability-kicker">{spotlight.kicker}</span>
                  <h3>{spotlight.title}</h3>
                  <p>{spotlight.body}</p>
                </div>
                <div className="capability-details">
                  <span className="capability-status">{spotlight.status}</span>
                  <ul>
                    {spotlight.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </div>
              </article>
            ))}
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
        </section>

        <section className="section-shell section-block architecture-section" id="architecture">
          <div className="section-heading split-heading">
            <div>
              <p className="eyebrow">{content.architecture.eyebrow}</p>
              <h2>{content.architecture.title}</h2>
            </div>
            <div>
              <p>{content.architecture.body}</p>
              <p className="architecture-note">{content.architecture.current}</p>
            </div>
          </div>

          <div className="architecture-map" aria-label={content.nav.architecture}>
            <div className="architecture-node is-operator">
              <span>01</span>
              {content.architecture.nodes.operator}
            </div>
            <span aria-hidden="true" className="architecture-connector">→</span>
            <div className="architecture-node is-control">
              <span>02</span>
              {content.architecture.nodes.control}
              <small>{content.architecture.nodes.ledger}</small>
            </div>
            <span aria-hidden="true" className="architecture-connector">→</span>
            <div className="architecture-node is-host">
              <span>03</span>
              {content.architecture.nodes.host}
              <div className="host-stack">
                <span className="is-active">{content.architecture.nodes.hostActive}</span>
                <span>{content.architecture.nodes.hostFuture}</span>
              </div>
              <small>{content.architecture.nodes.workspace}</small>
            </div>
            <span aria-hidden="true" className="architecture-connector">→</span>
            <div className="architecture-node is-agents">
              <span>04</span>
              {content.architecture.nodes.agents}
            </div>
          </div>
          <div className="adapter-rail">
            <span>{content.architecture.adapters}</span>
            <strong>{content.architecture.ready}</strong>
            <span>{content.architecture.gated}</span>
          </div>
        </section>

        <section className="repository-section">
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
                {content.footer.tagline} <strong>{content.footer.taglineAccent}</strong>
              </p>
            </div>

            {footerColumns.map((column) => (
              <nav aria-label={column.title} className="footer-column" key={column.title}>
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
            <nav aria-label={content.footer.contacts.title} className="footer-contacts">
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
