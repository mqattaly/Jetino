import { useEffect } from 'react';

/**
 * The moving light behind every screen. It is decoration only: the layer is
 * `aria-hidden`, never receives pointer events, and sits *below* the app so it
 * cannot cover a control. Colours come from the active accent, so the liquid
 * follows the palette instead of inventing one of its own.
 */
export function LiquidBackdrop() {
  return <div className="liquid-backdrop" aria-hidden="true">
    <span className="liquid-blob blob-one" />
    <span className="liquid-blob blob-two" />
    <span className="liquid-blob blob-three" />
    <span className="liquid-veil" />
  </div>;
}

/**
 * A thin liquid bar on the very top edge that runs while any request is in
 * flight. It saves every page from inventing its own "…" text and replaces
 * nothing: pages still render their own skeletons.
 */
export function installLiquidProgress() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const original = window.fetch;
  if (!original || (original as unknown as { liquid?: boolean }).liquid) return;
  const bar = document.createElement('div');
  bar.className = 'liquid-progress';
  bar.setAttribute('aria-hidden', 'true');
  bar.innerHTML = '<i></i>';
  const attach = () => document.body.appendChild(bar);
  if (document.body) attach(); else window.addEventListener('DOMContentLoaded', attach, { once: true });

  let pending = 0;
  const paint = () => {
    bar.dataset.active = pending > 0 ? 'true' : 'false';
  };
  const wrapped = function liquidFetch(this: unknown, ...args: Parameters<typeof fetch>) {
    pending += 1;
    paint();
    const done = () => {
      pending = Math.max(0, pending - 1);
      // keep the bar visible for a beat so a fast response still reads as movement
      window.setTimeout(paint, pending > 0 ? 0 : 260);
    };
    return original.apply(this, args).then(
      (response: Response) => { done(); return response; },
      (error: unknown) => { done(); throw error; },
    );
  };
  (wrapped as unknown as { liquid?: boolean }).liquid = true;
  window.fetch = wrapped as typeof fetch;
}

type SkeletonSize = number | string;

/** One shimmering block. Size is optional so it can fill its grid cell. */
export function Skeleton({ width, height, radius, className = '' }: { width?: SkeletonSize; height?: SkeletonSize; radius?: SkeletonSize; className?: string }) {
  return <span className={`sk ${className}`.trim()} aria-hidden="true"
    style={{ width, height, borderRadius: radius }} />;
}

/** A stack of text lines; the last one is short on purpose so it reads as a paragraph. */
export function SkeletonLines({ rows = 2, className = '' }: { rows?: number; className?: string }) {
  return <span className={`sk-lines ${className}`.trim()} aria-hidden="true">
    {Array.from({ length: rows }, (_, index) => <span className="sk sk-line" key={index} style={{ width: index === rows - 1 ? '58%' : undefined }} />)}
  </span>;
}

/**
 * The loading shape of a list: rows with an icon block, two text lines and a
 * trailing pill. It mirrors `.queue-empty` lists (orders, checks, tickets) so
 * the page does not jump when the real rows arrive.
 */
export function SkeletonList({ rows = 4, label = 'در حال بارگذاری…', className = '' }: { rows?: number; label?: string; className?: string }) {
  return <div className={`sk-list ${className}`.trim()} role="status" aria-live="polite" aria-busy="true">
    <span className="sr-only">{label}</span>
    {Array.from({ length: rows }, (_, index) => <div className="sk-row" key={index} aria-hidden="true">
      <span className="sk sk-avatar" />
      <span className="sk-row-body">
        <span className="sk sk-line" style={{ width: index % 2 ? '64%' : '78%' }} />
        <span className="sk sk-line sk-line-thin" style={{ width: index % 2 ? '42%' : '52%' }} />
      </span>
      <span className="sk sk-pill" />
    </div>)}
  </div>;
}

/** The loading shape of the admin tables (business performance, settlements). */
export function SkeletonTable({ rows = 4, cols = 5, label = 'در حال بارگذاری…' }: { rows?: number; cols?: number; label?: string }) {
  return <div className="sk-table" role="status" aria-live="polite" aria-busy="true">
    <span className="sr-only">{label}</span>
    <div className="sk-table-row sk-table-head" aria-hidden="true">
      {Array.from({ length: cols }, (_, index) => <span className="sk sk-line sk-line-thin" key={index} />)}
    </div>
    {Array.from({ length: rows }, (_, row) => <div className="sk-table-row" key={row} aria-hidden="true">
      {Array.from({ length: cols }, (_, col) => <span className="sk sk-line" key={col} style={{ width: col === 0 ? '86%' : `${52 + ((row + col) % 3) * 12}%` }} />)}
    </div>)}
  </div>;
}

/** The home page grid while businesses load. */
export function SkeletonCards({ count = 6, className = 'restaurant-grid', label = 'در حال گرفتن فهرست کسب‌وکارها…' }: { count?: number; className?: string; label?: string }) {
  return <div className={`${className} sk-cards`} role="status" aria-live="polite" aria-busy="true">
    <span className="sr-only">{label}</span>
    {Array.from({ length: count }, (_, index) => <div className="sk-card" key={index} aria-hidden="true">
      <span className="sk sk-card-media" />
      <span className="sk-card-body">
        <span className="sk sk-line" style={{ width: '72%' }} />
        <span className="sk sk-line sk-line-thin" style={{ width: '88%' }} />
        <span className="sk sk-line sk-line-thin" style={{ width: '46%' }} />
      </span>
    </div>)}
  </div>;
}

/** The menu sheet while a restaurant's categories load. */
export function SkeletonDishes({ count = 4 }: { count?: number }) {
  return <div className="sk-dishes" role="status" aria-live="polite" aria-busy="true">
    <span className="sr-only">منو دارد می‌آید…</span>
    {Array.from({ length: count }, (_, index) => <div className="sk-dish" key={index} aria-hidden="true">
      <span className="sk sk-dish-media" />
      <span className="sk-row-body">
        <span className="sk sk-line" style={{ width: '58%' }} />
        <span className="sk sk-line sk-line-thin" style={{ width: '82%' }} />
        <span className="sk sk-line sk-line-thin" style={{ width: '34%' }} />
      </span>
    </div>)}
  </div>;
}

/**
 * The brand's liquid loader: a blob that keeps changing shape while a ring of
 * light travels around it. `full` turns it into a whole page (the cold-start
 * boot screen in `index.html` uses the same shapes in plain HTML/CSS).
 */
export function LiquidLoader({ label = 'دارم آماده می‌کنم…', full = false }: { label?: string; full?: boolean }) {
  return <div className={`liquid-loader${full ? ' is-full' : ''}`} role="status" aria-live="polite">
    <div className="liquid-loader-stage" aria-hidden="true">
      <span className="liquid-loader-ring" />
      <span className="liquid-loader-blob"><img src="/brand/logo-loader.png" alt="" width="86" height="53" decoding="async"/></span>
      <span className="liquid-loader-drop drop-a" />
      <span className="liquid-loader-drop drop-b" />
    </div>
    <p className="liquid-loader-label">{label}</p>
    <div className="liquid-loader-bar" aria-hidden="true"><i /></div>
  </div>;
}

/** Small spinner that fits inside a button or beside a label. */
export function InlineLoader({ label }: { label?: string }) {
  return <span className="inline-loader" role="status" aria-live="polite">
    <i aria-hidden="true" />{label && <span>{label}</span>}
  </span>;
}

/**
 * Adds the `is-in` class to `.reveal` blocks once, a frame after mount, so CSS
 * can play a staggered entrance without any page knowing about it.
 */
export function useReveal() {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => document.documentElement.classList.add('reveal-ready'));
    return () => window.cancelAnimationFrame(frame);
  }, []);
}
