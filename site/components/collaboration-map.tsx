import type { ReactElement } from "react";

export type CollaborationActor = "human" | "agent";

type CollaborationActorGlyphProps = {
  actor: CollaborationActor;
};

type CollaborationMapProps = {
  agentLabel: string;
  ariaLabel: string;
  humanLabel: string;
};

export function CollaborationActorGlyph({
  actor,
}: CollaborationActorGlyphProps): ReactElement {
  return (
    <span aria-hidden="true" className={`collaboration-glyph is-${actor}`}>
      {actor === "human" ? (
        <svg fill="currentColor" viewBox="0 0 16 16">
          <circle cx="8" cy="4.5" r="2.6" />
          <path d="M2.4 14c0-3.1 2.5-5.4 5.6-5.4s5.6 2.3 5.6 5.4H2.4z" />
        </svg>
      ) : (
        <svg fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 16 16">
          <rect height="9" rx="2" width="12" x="2" y="4" />
          <circle cx="6" cy="8.5" fill="currentColor" r="0.9" stroke="none" />
          <circle cx="10" cy="8.5" fill="currentColor" r="0.9" stroke="none" />
          <line x1="8" x2="8" y1="2" y2="4" />
          <circle cx="8" cy="1.6" fill="currentColor" r="0.8" stroke="none" />
        </svg>
      )}
    </span>
  );
}

export function CollaborationMap({
  agentLabel,
  ariaLabel,
  humanLabel,
}: CollaborationMapProps): ReactElement {
  return (
    <div className="collaboration-map-frame">
      <svg
        aria-label={ariaLabel}
        className="collaboration-map-svg"
        role="img"
        viewBox="0 0 420 420"
      >
        <defs>
          <marker id="collaboration-arrow-accent" markerHeight="6" markerWidth="6" orient="auto" refX="8" refY="5" viewBox="0 0 10 10">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--amber)" />
          </marker>
          <marker id="collaboration-arrow-accent-start" markerHeight="6" markerWidth="6" orient="auto" refX="2" refY="5" viewBox="0 0 10 10">
            <path d="M10 0 L0 5 L10 10 z" fill="var(--amber)" />
          </marker>
          <marker id="collaboration-arrow-ink" markerHeight="6" markerWidth="6" orient="auto" refX="8" refY="5" viewBox="0 0 10 10">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--ink)" />
          </marker>
          <marker id="collaboration-arrow-ink-start" markerHeight="6" markerWidth="6" orient="auto" refX="2" refY="5" viewBox="0 0 10 10">
            <path d="M10 0 L0 5 L10 10 z" fill="var(--ink)" />
          </marker>
        </defs>

        <line
          className="collaboration-diagonal"
          markerEnd="url(#collaboration-arrow-accent)"
          markerStart="url(#collaboration-arrow-accent-start)"
          x1="100"
          x2="320"
          y1="100"
          y2="320"
        />
        <line
          className="collaboration-diagonal is-reverse"
          markerEnd="url(#collaboration-arrow-accent)"
          markerStart="url(#collaboration-arrow-accent-start)"
          x1="320"
          x2="100"
          y1="100"
          y2="320"
        />
        <line
          className="collaboration-horizontal"
          markerEnd="url(#collaboration-arrow-ink)"
          markerStart="url(#collaboration-arrow-ink-start)"
          x1="125"
          x2="295"
          y1="100"
          y2="100"
        />
        <line
          className="collaboration-horizontal"
          markerEnd="url(#collaboration-arrow-ink)"
          markerStart="url(#collaboration-arrow-ink-start)"
          x1="125"
          x2="295"
          y1="320"
          y2="320"
        />

        <circle className="collaboration-center" cx="210" cy="210" r="22" />
        <text className="collaboration-center-label" textAnchor="middle" x="210" y="215">
          ×
        </text>

        <g className="collaboration-human-node" transform="translate(70 70)">
          <rect height="60" rx="12" width="60" />
          <g fill="var(--paper)" transform="translate(30 30)">
            <circle cy="-7" r="7" />
            <path d="M-13 16c0-8 6-14 13-14s13 6 13 14z" />
          </g>
        </g>
        <text className="collaboration-node-label" textAnchor="middle" x="100" y="148">
          {humanLabel}
        </text>

        <g className="collaboration-human-node" transform="translate(290 70)">
          <rect height="60" rx="12" width="60" />
          <g fill="var(--paper)" transform="translate(30 30)">
            <circle cy="-7" r="7" />
            <path d="M-13 16c0-8 6-14 13-14s13 6 13 14z" />
          </g>
        </g>
        <text className="collaboration-node-label" textAnchor="middle" x="320" y="148">
          {humanLabel}
        </text>

        <g className="collaboration-agent-node" transform="translate(70 290)">
          <rect height="60" rx="12" width="60" />
          <g fill="none" stroke="var(--ink)" strokeWidth="1.6" transform="translate(30 32)">
            <rect height="20" rx="5" width="26" x="-13" y="-9" />
            <circle cx="-5" cy="1" fill="var(--ink)" r="1.6" stroke="none" />
            <circle cx="5" cy="1" fill="var(--ink)" r="1.6" stroke="none" />
            <line x1="0" x2="0" y1="-15" y2="-9" />
            <circle cx="0" cy="-17" fill="var(--ink)" r="1.6" stroke="none" />
          </g>
        </g>
        <text className="collaboration-node-label" textAnchor="middle" x="100" y="370">
          {agentLabel}
        </text>

        <g className="collaboration-agent-node" transform="translate(290 290)">
          <rect height="60" rx="12" width="60" />
          <g fill="none" stroke="var(--ink)" strokeWidth="1.6" transform="translate(30 32)">
            <rect height="20" rx="5" width="26" x="-13" y="-9" />
            <circle cx="-5" cy="1" fill="var(--ink)" r="1.6" stroke="none" />
            <circle cx="5" cy="1" fill="var(--ink)" r="1.6" stroke="none" />
            <line x1="0" x2="0" y1="-15" y2="-9" />
            <circle cx="0" cy="-17" fill="var(--ink)" r="1.6" stroke="none" />
          </g>
        </g>
        <text className="collaboration-node-label" textAnchor="middle" x="320" y="370">
          {agentLabel}
        </text>

        <text className="collaboration-edge-label" textAnchor="middle" x="210" y="90">
          h ↔ h
        </text>
        <text className="collaboration-edge-label" textAnchor="middle" x="210" y="340">
          a ↔ a
        </text>
        <text className="collaboration-edge-label is-accent" textAnchor="middle" transform="rotate(45 155 195)" x="155" y="195">
          h → a
        </text>
        <text className="collaboration-edge-label is-accent" textAnchor="middle" transform="rotate(-45 265 195)" x="265" y="195">
          a → h
        </text>
      </svg>
    </div>
  );
}
