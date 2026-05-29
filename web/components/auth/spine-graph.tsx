"use client";

import type { ReactElement } from "react";

import { useEffect, useRef } from "react";

type Tone =
  | "is-prompt"
  | "is-note"
  | "is-hot"
  | "is-ok"
  | "is-reject"
  | "is-tagline";

interface TermLine {
  style: Tone;
  text: string;
}

const LOG: ReadonlyArray<TermLine> = [
  { style: "is-prompt", text: "$ maister status" },
  { style: "is-note", text: "↳ daemon up · localhost:3000 · 12 intents" },
  { style: "is-prompt", text: "$ maister run --autonomous" },
  { style: "is-note", text: "↳ intent #427 → task t-7c2e on backlog" },
  { style: "is-note", text: "↳ flow f-auth created · 4 steps" },
  { style: "is-hot", text: "⚡ t-7c2e · claim by claude/sonnet" },
  { style: "is-note", text: "· tests 12/12 · lint ok · types ok" },
  { style: "is-ok", text: "✓ review by you · approved" },
  { style: "is-ok", text: "✓ t-7c2e merged → main@4f2a · shipped" },
  { style: "is-prompt", text: "$ platform-agent --tail logs" },
  { style: "is-note", text: "↳ scan: 14k lines · 3 anomalies" },
  { style: "is-hot", text: "⚠ error rate +0.4% on /auth/* (post-ship)" },
  { style: "is-note", text: "↳ distill → task t-7c2f on backlog" },
  { style: "is-hot", text: "⚡ t-7c30 · claim by codex" },
  { style: "is-reject", text: "✗ review by you · rejected · spec ambiguous" },
  { style: "is-note", text: "↳ flow f-auth reopened · revised" },
  { style: "is-tagline", text: "// where ship happens." },
];

const TERM_LINE_BASE = "block overflow-hidden whitespace-nowrap";

const TONE: Record<Tone, string> = {
  "is-prompt": "text-[color-mix(in_oklab,var(--amber)_80%,var(--paper))]",
  "is-note": "text-[color-mix(in_oklab,var(--paper)_55%,transparent)]",
  "is-hot": "text-[color-mix(in_oklab,var(--amber)_80%,var(--paper))]",
  "is-ok": "text-[color-mix(in_oklab,var(--accent-4)_70%,var(--paper))]",
  "is-reject": "text-[#e8746f]",
  "is-tagline": "italic text-amber",
};

const NS = "http://www.w3.org/2000/svg";

const NODE_AT: Record<string, { x: number; y: number }> = {
  n1: { x: 35, y: 110 },
  n2: { x: 95, y: 110 },
  n3: { x: 160, y: 110 },
  n4: { x: 220, y: 110 },
  n5: { x: 280, y: 110 },
  n6: { x: 340, y: 110 },
  n7: { x: 425, y: 110 },
};

interface ParticleOpts {
  color?: string;
  cls?: string;
  duration?: number;
  pingVariant?: string | null;
  endVariant?: string;
  onEnd?: () => void;
}

export function SpineGraph(): ReactElement {
  const svgRef = useRef<SVGSVGElement>(null);
  const rowRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const activeTextRef = useRef<HTMLSpanElement>(null);
  const activeLineRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const svg = svgRef.current;

    if (!svg) return;

    const graph = svg;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const cleanups: Array<() => void> = [];
    let stopped = false;

    // ── terminal: type each line, commit to history, loop ──────────
    function startTerminal(): () => void {
      const rows = rowRefs.current;
      const activeText = activeTextRef.current;
      const activeLine = activeLineRef.current;

      if (!activeText || !activeLine) return () => {};

      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const history: TermLine[] = [];

      const paintHistory = (): void => {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];

          if (!row) continue;
          const h = history[history.length - rows.length + i];

          row.className = TERM_LINE_BASE + (h ? ` ${TONE[h.style]}` : "");
          row.textContent = h ? h.text : "";
        }
      };

      if (reduce) {
        const tail = LOG.slice(-(rows.length + 1));

        tail.slice(0, rows.length).forEach((l) => history.push(l));
        paintHistory();
        const last = tail[tail.length - 1];

        activeLine.className = `${TERM_LINE_BASE} ${TONE[last.style]}`;
        activeText.textContent = last.text;

        return () => {};
      }

      let idx = 0;

      const typeNext = (): void => {
        const line = LOG[idx % LOG.length];

        idx++;
        activeLine.className = `${TERM_LINE_BASE} ${TONE[line.style]}`;
        activeText.textContent = "";

        let i = 0;

        const typeChar = (): void => {
          activeText.textContent = line.text.slice(0, i + 1);
          i++;

          if (i < line.text.length) {
            const ch = line.text[i - 1];
            let delay = 18 + Math.random() * 28;

            if (ch === " ") delay = 14;
            if (/[.,:;!?]/.test(ch)) delay = 90;
            timers.push(setTimeout(typeChar, delay));
          } else {
            timers.push(
              setTimeout(() => {
                history.push(line);
                if (history.length > rows.length + 4) history.shift();
                paintHistory();
                activeText.textContent = "";
                timers.push(setTimeout(typeNext, 350 + Math.random() * 250));
              }, 650),
            );
          }
        };

        typeChar();
      };

      typeNext();

      return () => timers.forEach(clearTimeout);
    }

    // ── delivery graph: particles flow, nodes ping, review gate ────
    function startGraph(): () => void {
      const particles = graph.querySelector("#g-particles");
      const pings = graph.querySelector("#g-pings");

      if (!particles || !pings) return () => {};

      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const intervals: Array<ReturnType<typeof setInterval>> = [];

      const nearestNodeAt = (x: number, y: number): string | null => {
        let best: string | null = null;
        let bd = Infinity;

        for (const id in NODE_AT) {
          const n = NODE_AT[id];
          const d = Math.hypot(n.x - x, n.y - y);

          if (d < bd) {
            bd = d;
            best = id;
          }
        }

        return bd < 12 ? best : null;
      };

      const pingNode = (
        nodeId: string | null,
        variant?: string | null,
      ): void => {
        if (!nodeId) return;
        const n = NODE_AT[nodeId];

        if (!n) return;
        const c = document.createElementNS(NS, "circle");

        c.setAttribute("cx", String(n.x));
        c.setAttribute("cy", String(n.y));
        c.setAttribute("r", "5");
        c.setAttribute("class", `g-node-ping${variant ? ` ${variant}` : ""}`);
        pings.appendChild(c);
        timers.push(setTimeout(() => c.remove(), 900));

        const node = graph.querySelector<SVGCircleElement>(
          `.g-node[data-id="${nodeId}"]`,
        );

        if (node && variant !== "is-merged") {
          node.classList.add("is-hot");
          timers.push(setTimeout(() => node.classList.remove("is-hot"), 700));
        }
      };

      const spawnParticle = (pathSel: string, opts: ParticleOpts): void => {
        const path = graph.querySelector<SVGPathElement>(pathSel);

        if (!path) return;
        const total = path.getTotalLength();
        const dur = opts.duration ?? 4200;
        const dot = document.createElementNS(NS, "circle");

        dot.setAttribute("r", "3");
        dot.setAttribute("fill", opts.color ?? "var(--amber)");
        dot.setAttribute(
          "class",
          `g-particle${opts.cls ? ` ${opts.cls}` : ""}`,
        );
        particles.appendChild(dot);

        let lastHit: string | null = null;
        const start = performance.now();

        const step = (now: number): void => {
          if (stopped) {
            dot.remove();

            return;
          }
          const k = (now - start) / dur;

          if (k >= 1) {
            const end = path.getPointAtLength(total);
            const hit = nearestNodeAt(end.x, end.y);

            if (hit && hit !== lastHit)
              pingNode(hit, opts.endVariant ?? opts.pingVariant);
            dot.remove();
            opts.onEnd?.();

            return;
          }
          const pt = path.getPointAtLength(total * k);

          dot.setAttribute("cx", String(pt.x));
          dot.setAttribute("cy", String(pt.y));

          const hit = nearestNodeAt(pt.x, pt.y);

          if (hit && hit !== lastHit) {
            lastHit = hit;
            if (opts.pingVariant !== null) pingNode(hit, opts.pingVariant);
          }
          requestAnimationFrame(step);
        };

        requestAnimationFrame(step);
      };

      const flash = (sel: string, cls: string, ms: number): void => {
        const el = graph.querySelector(sel);

        if (!el) return;
        el.classList.add(cls);
        timers.push(setTimeout(() => el.classList.remove(cls), ms));
      };

      let reviewArrivals = 0;

      const spawnReviewedIntent = (color: string, cls: string): void => {
        spawnParticle("#g-intent-to-review", {
          color,
          cls,
          duration: 3600,
          pingVariant: cls === "is-accent" ? "is-accent" : "is-hot",
          onEnd: () => {
            reviewArrivals++;
            const reject = reviewArrivals % 3 === 0;

            if (reject) {
              flash("#g-human", "is-reject", 1500);
              flash('.g-node[data-id="n6"]', "is-reject", 1500);
              flash("#g-review-back", "is-active", 2600);
              timers.push(
                setTimeout(() => {
                  spawnParticle("#g-review-back", {
                    color: "#d9534f",
                    cls: "is-reject",
                    duration: 2400,
                    pingVariant: "is-reject",
                  });
                }, 250),
              );
            } else {
              flash("#g-human", "is-pass", 1100);
              timers.push(
                setTimeout(() => {
                  spawnParticle("#g-review-to-ship", {
                    color,
                    cls,
                    duration: 1700,
                    pingVariant: cls === "is-accent" ? "is-accent" : "is-hot",
                    endVariant: "is-merged",
                  });
                }, 200),
              );
            }
          },
        });
      };

      let beat = 0;

      const tick = (): void => {
        const m = beat % 8;

        if (m === 0) spawnReviewedIntent("var(--amber)", "");
        if (m === 1) {
          spawnParticle("#g-branch-a", {
            color: "var(--amber)",
            duration: 3600,
            pingVariant: "is-hot",
          });
        }
        if (m === 2) spawnReviewedIntent("var(--accent-3)", "is-accent");
        if (m === 3) {
          spawnParticle("#g-branch-b", {
            color: "var(--accent-3)",
            cls: "is-accent",
            duration: 3200,
            pingVariant: "is-accent",
          });
        }
        if (m === 4) {
          spawnParticle("#g-rework", {
            color: "var(--mute)",
            duration: 6200,
            pingVariant: null,
          });
        }
        if (m === 5) {
          spawnParticle("#g-branch-c", {
            color: "var(--mute-2)",
            duration: 5400,
          });
        }
        if (m === 6) {
          spawnParticle("#g-branch-a", {
            color: "var(--amber)",
            duration: 3000,
            pingVariant: "is-hot",
          });
        }
        if (m === 7) {
          spawnParticle("#g-rework", {
            color: "var(--mute)",
            duration: 6800,
            pingVariant: null,
          });
        }
        beat++;
      };

      tick();
      intervals.push(setInterval(tick, 900));

      return () => {
        timers.forEach(clearTimeout);
        intervals.forEach(clearInterval);
        particles.innerHTML = "";
        pings.innerHTML = "";
      };
    }

    const startAll = (): void => {
      if (stopped) return;
      cleanups.push(startTerminal());
      if (!reduce) cleanups.push(startGraph());
    };

    // Only animate once the panel is actually on screen — the aside is
    // display:none below the lg breakpoint, where getPointAtLength is unsafe.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          startAll();
        }
      },
      { threshold: 0.05 },
    );

    io.observe(graph);

    return () => {
      stopped = true;
      io.disconnect();
      cleanups.forEach((fn) => fn());
    };
  }, []);

  return (
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
        ref={svgRef}
        aria-hidden="true"
        className="spine-graph-svg block h-auto w-full px-1.5 pb-1.5 pt-3.5 [background:linear-gradient(180deg,var(--paper)_0%,color-mix(in_oklab,var(--ivory)_40%,var(--paper))_100%)]"
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
          className="g-spine"
          d="M 35 110 L 415 110"
          markerEnd="url(#g-arrow)"
        />

        <path
          d="M 35 110 L 340 110"
          fill="none"
          id="g-intent-to-review"
          stroke="none"
        />
        <path
          d="M 340 110 L 415 110"
          fill="none"
          id="g-review-to-ship"
          stroke="none"
        />

        <path
          className="g-branch"
          d="M 160 110 C 160 78, 180 58, 210 58 L 290 58 C 320 58, 340 80, 340 110"
          id="g-branch-a"
        />
        <path
          className="g-branch b-accent"
          d="M 220 110 C 220 92, 250 80, 280 80 L 380 80 C 410 80, 425 92, 425 110"
          id="g-branch-b"
        />
        <path
          className="g-branch b-pending"
          d="M 280 110 C 280 132, 310 144, 340 144 L 425 144"
          id="g-branch-c"
        />
        <path
          className="g-review-back"
          d="M 340 110 C 340 130, 320 134, 290 134 L 210 134 C 180 134, 160 130, 160 110"
          id="g-review-back"
        />
        <path
          className="g-rework"
          d="M 425 110 C 425 168, 410 196, 370 196 L 130 196 C 100 196, 95 168, 95 110"
          id="g-rework"
          markerEnd="url(#g-arrow-rework)"
        />

        <g>
          <circle className="g-node" cx="35" cy="110" data-id="n1" r="5" />
          <circle className="g-node" cx="95" cy="110" data-id="n2" r="5" />
          <circle className="g-node" cx="160" cy="110" data-id="n3" r="5" />
          <circle className="g-node" cx="220" cy="110" data-id="n4" r="5" />
          <circle className="g-node" cx="280" cy="110" data-id="n5" r="5" />
          <circle className="g-node" cx="340" cy="110" data-id="n6" r="5" />
          <circle
            className="g-node is-merged"
            cx="425"
            cy="110"
            data-id="n7"
            r="5"
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

        <g className="g-human" id="g-human">
          <line className="g-human-link" x1="358" x2="345" y1="100" y2="108" />
          <circle className="g-human-head" cx="358" cy="91" r="2.6" />
          <path
            className="g-human-body"
            d="M 353 100 C 353 95 363 95 363 100"
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

        <g id="g-particles" />
        <g id="g-pings" />
      </svg>

      <div className="h-[104px] overflow-hidden border-t border-line bg-[color-mix(in_oklab,var(--ink)_96%,transparent)] px-4 pb-3 pt-2.5 font-mono text-[11.5px] leading-[1.55] dark:bg-[color-mix(in_oklab,var(--ink)_12%,var(--paper))]">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            className={TERM_LINE_BASE}
          />
        ))}
        <span ref={activeLineRef} className={TERM_LINE_BASE}>
          <span ref={activeTextRef} />
          <span className="ml-0.5 inline-block h-[13px] w-[7px] translate-y-[2px] bg-[color-mix(in_oklab,var(--paper)_80%,transparent)] animate-[term-blink_1.05s_steps(1)_infinite]" />
        </span>
      </div>
    </div>
  );
}
