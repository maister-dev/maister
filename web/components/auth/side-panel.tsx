import type { ReactElement } from "react";

import { getTranslations } from "next-intl/server";

const TERM_LINES: ReadonlyArray<{ text: string; tone: string }> = [
  {
    text: "$ maister status",
    tone: "text-[color-mix(in_oklab,var(--amber)_80%,var(--paper))]",
  },
  {
    text: "↳ daemon up · localhost:3000 · 12 intents",
    tone: "text-[color-mix(in_oklab,var(--paper)_55%,transparent)]",
  },
  {
    text: "⚡ t-7c2e · claim by claude/sonnet",
    tone: "text-[color-mix(in_oklab,var(--amber)_80%,var(--paper))]",
  },
  {
    text: "✓ review by you · approved",
    tone: "text-[color-mix(in_oklab,var(--accent-4)_70%,var(--paper))]",
  },
  {
    text: "✓ t-7c2e merged → main@4f2a · shipped",
    tone: "text-[color-mix(in_oklab,var(--accent-4)_70%,var(--paper))]",
  },
  { text: "// where ship happens.", tone: "italic text-amber" },
];

export async function SidePanel(): Promise<ReactElement> {
  const t = await getTranslations("side");
  const motto = (await getTranslations())("footer.motto");

  return (
    <div className="relative z-[2] w-full max-w-[560px]">
      <div className="mb-[18px] inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-mute">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]" />
        {t("spineEye")}
      </div>

      <h3 className="m-0 mb-3 max-w-[18ch] text-[30px] font-semibold leading-[1.1] tracking-[-0.022em] text-ink">
        <em className="not-italic font-semibold text-amber [background:linear-gradient(180deg,transparent_62%,var(--amber-soft)_62%)] [margin:0_-3px] [padding:0_3px]">
          {t("spineH3em")}
        </em>
        <br />
        {t("spineH3rest")}
      </h3>

      <p className="m-0 mb-[22px] max-w-[44ch] text-sm leading-[1.55] text-mute">
        {t("spineSub")}
      </p>

      <div className="w-full overflow-hidden rounded-xl border border-line bg-paper shadow-md">
        <div className="flex items-center justify-between border-b border-line bg-ivory px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-mute">
          <span className="font-semibold text-ink-2">
            ~/projects/maister · graph
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-4 animate-[pulse-dot_2.2s_ease-out_infinite]" />
            live
          </span>
        </div>

        <svg
          aria-hidden="true"
          className="block h-auto w-full px-1.5 pb-1.5 pt-3.5 [background:linear-gradient(180deg,var(--paper)_0%,color-mix(in_oklab,var(--ivory)_40%,var(--paper))_100%)]"
          preserveAspectRatio="xMidYMid meet"
          viewBox="0 0 460 230"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <marker
              id="g-arrow"
              markerHeight="6"
              markerWidth="6"
              orient="auto"
              refX="9"
              refY="5"
              viewBox="0 0 10 10"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="var(--ink)" />
            </marker>
            <marker
              id="g-arrow-rework"
              markerHeight="5.5"
              markerWidth="5.5"
              orient="auto"
              refX="9"
              refY="5"
              viewBox="0 0 10 10"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="var(--mute)" />
            </marker>
          </defs>

          <g
            fill="var(--mute)"
            fontFamily="var(--mono)"
            fontSize="8.5"
            letterSpacing="0.03em"
            textAnchor="middle"
          >
            <text x="35" y="22">
              intent
            </text>
            <text x="95" y="22">
              task
            </text>
            <text x="160" y="22">
              flow
            </text>
            <text x="220" y="22">
              claim
            </text>
            <text x="280" y="22">
              work
            </text>
            <text x="340" y="22">
              review
            </text>
            <text x="425" y="22">
              ship
            </text>
          </g>

          <path
            d="M 35 110 L 415 110"
            fill="none"
            markerEnd="url(#g-arrow)"
            stroke="var(--ink)"
            strokeLinecap="round"
            strokeWidth="1.6"
          />

          <path
            d="M 160 110 C 160 78, 180 58, 210 58 L 290 58 C 320 58, 340 80, 340 110"
            fill="none"
            stroke="var(--amber)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.4"
          />
          <path
            d="M 220 110 C 220 92, 250 80, 280 80 L 380 80 C 410 80, 425 92, 425 110"
            fill="none"
            stroke="var(--accent-3)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.4"
          />
          <path
            d="M 280 110 C 280 132, 310 144, 340 144 L 425 144"
            fill="none"
            opacity="0.7"
            stroke="var(--mute-2)"
            strokeDasharray="3 3"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.4"
          />
          <path
            d="M 425 110 C 425 168, 410 196, 370 196 L 130 196 C 100 196, 95 168, 95 110"
            fill="none"
            markerEnd="url(#g-arrow-rework)"
            opacity="0.65"
            stroke="var(--mute)"
            strokeDasharray="2 4"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.2"
          />

          <g fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.5">
            <circle cx="35" cy="110" r="5" />
            <circle cx="95" cy="110" r="5" />
            <circle cx="160" cy="110" r="5" />
            <circle cx="220" cy="110" r="5" />
            <circle cx="280" cy="110" r="5" />
            <circle cx="340" cy="110" r="5" />
            <circle
              cx="425"
              cy="110"
              fill="var(--accent-4)"
              r="5"
              stroke="var(--accent-4)"
            />
          </g>

          <g>
            <circle cx="250" cy="58" fill="var(--amber)" r="3.5" />
            <circle cx="330" cy="80" fill="var(--accent-3)" r="3.5" />
            <circle cx="395" cy="144" fill="var(--mute-2)" r="3" />
          </g>

          <g
            fontFamily="var(--mono)"
            fontSize="8.5"
            fontWeight="600"
            textAnchor="middle"
          >
            <text fill="var(--amber)" x="250" y="49">
              claude
            </text>
            <text fill="var(--accent-3)" x="330" y="71">
              codex
            </text>
            <text fill="var(--mute-2)" fontWeight="400" x="395" y="136">
              queued
            </text>
          </g>

          <g>
            <line
              opacity="0.55"
              stroke="var(--mute-2)"
              strokeDasharray="1.5 2"
              strokeWidth="0.8"
              x1="358"
              x2="345"
              y1="100"
              y2="108"
            />
            <circle
              cx="358"
              cy="91"
              fill="var(--paper)"
              r="2.6"
              stroke="var(--mute)"
              strokeWidth="1.2"
            />
            <path
              d="M 353 100 C 353 95 363 95 363 100"
              fill="none"
              stroke="var(--mute)"
              strokeLinecap="round"
              strokeWidth="1.3"
            />
          </g>

          <g>
            <rect
              fill="var(--paper)"
              height="18"
              rx="9"
              stroke="var(--mute)"
              strokeWidth="1.2"
              width="80"
              x="190"
              y="187"
            />
            <circle cx="202" cy="196" fill="var(--mute)" r="2.2" />
            <text
              fill="var(--ink-2)"
              fontFamily="var(--mono)"
              fontSize="9"
              fontWeight="600"
              textAnchor="middle"
              x="234"
              y="199.5"
            >
              platform-agent
            </text>
          </g>

          <g
            fill="var(--mute)"
            fontFamily="var(--mono)"
            fontSize="8"
            letterSpacing="0.04em"
            textAnchor="middle"
          >
            <text x="125" y="221">
              logs
            </text>
            <text x="175" y="221">
              · errors
            </text>
            <text x="234" y="221">
              · distill
            </text>
            <text x="305" y="221">
              · new intents
            </text>
          </g>
        </svg>

        <div className="h-[104px] overflow-hidden border-t border-line bg-[color-mix(in_oklab,var(--ink)_96%,transparent)] px-4 pb-3 pt-2.5 font-mono text-[11.5px] leading-[1.55] dark:bg-[color-mix(in_oklab,var(--ink)_12%,var(--paper))]">
          {TERM_LINES.map((line) => (
            <span
              key={line.text}
              className={`block overflow-hidden whitespace-nowrap ${line.tone}`}
            >
              {line.text}
            </span>
          ))}
        </div>
      </div>

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

      <figure className="mt-9 border-t border-line-soft pt-8">
        <blockquote className="m-0 text-base leading-[1.5] text-ink-2">
          “{t("qQuote")}”
        </blockquote>
        <figcaption className="mt-3.5 flex items-center gap-3.5">
          <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full border border-amber-line bg-amber-soft font-mono text-sm font-bold tracking-[0.02em] text-amber">
            AK
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-ink">{t("qName")}</span>
            <span className="font-mono text-[11px] tracking-[0.04em] text-mute">
              {t("qRole")}
            </span>
          </span>
        </figcaption>
      </figure>

      <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-line bg-ivory px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-mute">
        <span className="h-[5px] w-[5px] rounded-full bg-amber" />
        {motto}
      </div>
    </div>
  );
}
