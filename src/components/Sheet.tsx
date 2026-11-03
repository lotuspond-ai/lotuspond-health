import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

export type Snap = 'peek' | 'half' | 'full';
const ORDER: Snap[] = ['peek', 'half', 'full'];

interface Props {
  snap: Snap;
  onSnap: (s: Snap) => void;
  /** Visible height in the collapsed state (handle + header). */
  peek: number;
  header: ReactNode;
  children: ReactNode;
  label: string;
  /** Changing it resets the body's scroll position (new content). */
  contentKey?: string;
  /** Height of the parent covered by the sheet once it settles (capped at half), for re-centring what is behind it. */
  onCover?: (px: number) => void;
}

/**
 * Bottom sheet over the 3D stage, phone layout only. Drag the handle/header between three heights,
 * or tap the header to toggle between collapsed and half. The body scrolls inside the visible part.
 */
export function Sheet({ snap, onSnap, peek, header, children, label, contentKey, onCover }: Props) {
  const ref = useRef<HTMLElement>(null);
  const [parentH, setParentH] = useState(0);
  const [dragH, setDragH] = useState<number | null>(null);
  const gesture = useRef<{ id: number } | null>(null);

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(([e]) => setParentH(Math.round(e.contentRect.height)));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const full = Math.max(peek, parentH - 12);
  const heights: Record<Snap, number> = { peek, half: Math.max(peek, Math.round(parentH * 0.52)), full };
  const settled = heights[snap];
  const visible = dragH ?? settled;

  const cover = Math.min(settled, heights.half);
  const lastCover = useRef(-1);
  useLayoutEffect(() => {
    if (!parentH || cover === lastCover.current) return;
    lastCover.current = cover;
    onCover?.(cover);
  }, [cover, parentH, onCover]);

  // Latest values for the window listeners of an ongoing drag.
  const live = useRef({ heights, snap, full, peek, onSnap });
  useLayoutEffect(() => { live.current = { heights, snap, full, peek, onSnap }; });

  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || gesture.current) return;
    const g = { id: e.pointerId, y0: e.clientY, h0: visible, t: e.timeStamp, y: e.clientY, v: 0, h: visible, moved: false };
    gesture.current = g;
    const downTarget = e.target as Element;
    // Follow the pointer on the window: a quick upward flick leaves the header before it counts as a drag,
    // and capturing the pointer up front would stop taps from reaching the header's buttons.
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== g.id) return;
      if (!g.moved && Math.abs(ev.clientY - g.y0) < 6) return;
      g.moved = true;
      const { full, peek } = live.current;
      const dt = Math.max(1, ev.timeStamp - g.t);
      g.v = 0.7 * g.v + 0.3 * ((g.y - ev.clientY) / dt); // px/ms, upward positive
      g.t = ev.timeStamp; g.y = ev.clientY;
      g.h = Math.min(full, Math.max(peek * 0.6, g.h0 + (g.y0 - ev.clientY)));
      setDragH(g.h);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== g.id) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      gesture.current = null;
      const { heights, snap, onSnap } = live.current;
      if (!g.moved) {
        if (ev.type === 'pointerup' && !downTarget.closest('button, a, input, select')) onSnap(snap === 'peek' ? 'half' : 'peek');
        return;
      }
      const projected = g.h + g.v * 180;
      const next = ORDER.reduce((best, s) => (Math.abs(heights[s] - projected) < Math.abs(heights[best] - projected) ? s : best), snap);
      setDragH(null);
      onSnap(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <section ref={ref} className={`sheet sheet--${snap}${dragH != null ? ' is-dragging' : ''}`} aria-label={label}
      style={{ height: full, transform: `translateY(${full - visible}px)` }}>
      {/* Sized to the visible height so the scrolling body ends at the bottom edge of the screen. */}
      <div className="sheet__inner" style={{ height: visible }}>
        <div className="sheet__grip" onPointerDown={onDown}>
          <button className="sheet__handle" aria-label={snap === 'peek' ? 'Show more' : 'Show less'} aria-expanded={snap !== 'peek'}
            onClick={() => onSnap(snap === 'peek' ? 'half' : 'peek')}><i /></button>
          {header}
        </div>
        <div className="sheet__body" key={contentKey}>{children}</div>
      </div>
    </section>
  );
}
