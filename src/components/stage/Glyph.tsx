// Line icons for the stage overlay and the 2D body map controls.
const PATHS = {
  map: <><circle cx="12" cy="4.6" r="2.1" /><path d="M8.2 21l1.1-7.2L6.5 13l1.9-5h7.2l1.9 5-2.8.8 1.1 7.2" /></>,
  cube: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>,
  skin: <><path d="M12 3.5c3.6 0 6.5 2.9 6.5 6.5 0 4.6-3.6 8.6-6.5 10.5C9.1 18.6 5.5 14.6 5.5 10c0-3.6 2.9-6.5 6.5-6.5z" /><path d="M9 10.5c.8 1 1.8 1.5 3 1.5s2.2-.5 3-1.5" /></>,
  bone: <><path d="M8.5 15.5l7-7" /><path d="M8.5 15.5a2.3 2.3 0 1 1-3.2 2.4 2.3 2.3 0 1 1 2.4-3.2M15.5 8.5a2.3 2.3 0 1 1 3.2-2.4 2.3 2.3 0 1 1-2.4 3.2" /></>,
  tag: <><path d="M4 12.6V5a1 1 0 0 1 1-1h7.6L20 11.4 12.4 19z" /><circle cx="8.5" cy="8.5" r="1.4" /></>,
  sun: <><circle cx="12" cy="12" r="3.8" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></>,
  glow: <><circle cx="12" cy="12" r="2.6" /><circle cx="12" cy="12" r="6" opacity="0.55" /><circle cx="12" cy="12" r="9.4" opacity="0.25" /></>,
  left: <path d="M14.5 6l-6 6 6 6" />,
  right: <path d="M9.5 6l6 6-6 6" />,
  drag: <><path d="M4 12h16M7 9l-3 3 3 3M17 9l3 3-3 3" /></>,
  orbit: <><ellipse cx="12" cy="12" rx="8.5" ry="3.6" /><path d="M16.8 5.4l1.8 1.4-1.9 1.2" /><circle cx="12" cy="12" r="1.6" /></>,
  zoom: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="M14.6 14.6L20 20M10.5 8v5M8 10.5h5" /></>,
  reset: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4 4v4h4" /></>,
  tap: <><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10l4.2.9a2 2 0 0 1 1.6 2.2l-.6 4.9a2 2 0 0 1-2 1.8h-4.5a2 2 0 0 1-1.6-.8L5.6 15a1.5 1.5 0 0 1 2.2-2z" /></>,
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name }: { name: GlyphName }) {
  return (
    <svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS[name]}
    </svg>
  );
}
