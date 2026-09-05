"use client";

/* eslint-disable @next/next/no-img-element -- pre-sized static screenshots; the standalone site image ships no optimizer */

import type { KeyboardEvent, ReactElement } from "react";

import { useState } from "react";

import { TOUR_IMAGE_HEIGHT, TOUR_IMAGE_WIDTH } from "@/lib/tour-assets";

export type TourShotView = {
  id: string;
  label: string;
  title: string;
  body: string;
  alt: string;
  lightSrc: string;
  darkSrc: string;
};

type ProductTourProps = {
  shots: ReadonlyArray<TourShotView>;
};

export function ProductTour({ shots }: ProductTourProps): ReactElement {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = shots[activeIndex] ?? shots[0];

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

    if (step === 0) return;
    event.preventDefault();
    const nextIndex = (activeIndex + step + shots.length) % shots.length;

    setActiveIndex(nextIndex);
    document.getElementById(`tour-tab-${shots[nextIndex]?.id}`)?.focus();
  };

  return (
    <div className="tour">
      <div
        aria-label="Product screens"
        className="tour-tabs"
        role="tablist"
        onKeyDown={onTabKeyDown}
      >
        {shots.map((shot, index) => (
          <button
            key={shot.id}
            aria-controls={`tour-panel-${shot.id}`}
            aria-selected={index === activeIndex}
            className="tour-tab"
            id={`tour-tab-${shot.id}`}
            role="tab"
            tabIndex={index === activeIndex ? 0 : -1}
            type="button"
            onClick={() => setActiveIndex(index)}
          >
            {shot.label}
          </button>
        ))}
      </div>

      <figure
        aria-labelledby={`tour-tab-${active.id}`}
        className="tour-stage"
        id={`tour-panel-${active.id}`}
        role="tabpanel"
      >
        <div className="tour-frame">
          <img
            alt={active.alt}
            className="tour-img is-light"
            decoding="async"
            height={TOUR_IMAGE_HEIGHT}
            src={active.lightSrc}
            width={TOUR_IMAGE_WIDTH}
          />
          {active.darkSrc !== active.lightSrc ? (
            <img
              alt={active.alt}
              className="tour-img is-dark"
              decoding="async"
              height={TOUR_IMAGE_HEIGHT}
              src={active.darkSrc}
              width={TOUR_IMAGE_WIDTH}
            />
          ) : null}
        </div>
        <figcaption className="tour-caption">
          <span className="tour-index">
            {String(activeIndex + 1).padStart(2, "0")} /{" "}
            {String(shots.length).padStart(2, "0")}
          </span>
          <h3>{active.title}</h3>
          <p>{active.body}</p>
        </figcaption>
      </figure>
    </div>
  );
}
