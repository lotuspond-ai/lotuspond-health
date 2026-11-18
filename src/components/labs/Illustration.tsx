// Drawings for the Find a lab empty states: a soft map with pins in the kind colours.
import { useId, type ReactNode } from 'react';

type Variant = 'find' | 'empty' | 'offline' | 'preview';

function Pin({ x, y, color, scale = 1 }: { x: number; y: number; color: string; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="0" cy="2" rx="7" ry="2.4" fill="#18211b" opacity="0.12" />
      <path d="M0 0c-6-7.5-10-12.4-10-17.6a10 10 0 0 1 20 0C10-12.4 6-7.5 0 0z" fill={color} />
      <circle cx="0" cy="-17.5" r="4" fill="#ffffff" />
    </g>
  );
}

export function LabsDrawing({ variant }: { variant: Variant }) {
  const clip = `lillus-${useId().replace(/:/g, '')}`;
  return (
    <svg className="lillus" viewBox="0 0 240 150" aria-hidden>
      <defs>
        <clipPath id={clip}><rect x="10" y="8" width="220" height="134" rx="22" /></clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect x="10" y="8" width="220" height="134" fill="#d5dfca" />
        <path d="M-10 104c40-18 70 8 110-6s70-40 150-22" stroke="#cfe0f0" strokeWidth="16" fill="none" opacity="0.9" />
        <path d="M30 0v160M96 0v160M168 0v160M0 46h260M0 118h260" stroke="#ffffff" strokeWidth="7" />
        <path d="M0 18l250 120" stroke="#ffffff" strokeWidth="4" opacity="0.8" />
        <rect x="104" y="56" width="56" height="34" rx="6" fill="#d5dfca" />
      </g>
      {variant === 'empty' ? (
        <>
          <circle cx="120" cy="78" r="46" fill="#55694a" fillOpacity="0.06" stroke="#55694a" strokeOpacity="0.5" strokeWidth="1.6" strokeDasharray="5 5" />
          <circle cx="120" cy="78" r="7" fill="#55694a" stroke="#ffffff" strokeWidth="3" />
        </>
      ) : variant === 'offline' ? (
        <g transform="translate(120 74)">
          <circle r="34" fill="#ffffff" />
          <path d="M-14 8h26a10 10 0 0 0 1-20 15 15 0 0 0-28-3A10 10 0 0 0-14 8z" fill="none" stroke="#4a564c" strokeWidth="4" strokeLinejoin="round" />
          <path d="M-20-20l40 40" stroke="#55694a" strokeWidth="4" strokeLinecap="round" />
        </g>
      ) : (
        <>
          <Pin x={62} y={70} color="#55694a" />
          <Pin x={182} y={58} color="#5b70c9" />
          <Pin x={150} y={124} color="#b07d12" scale={0.85} />
          <Pin x={88} y={128} color="#55694a" scale={0.9} />
          {variant === 'preview' ? (
            <g transform="translate(120 74)">
              <circle r="22" fill="#ffffff" stroke="#18211b" strokeOpacity="0.15" />
              <rect x="-10" y="-11" width="20" height="9" rx="2" fill="none" stroke="#33423a" strokeWidth="2.4" />
              <rect x="-10" y="2" width="20" height="9" rx="2" fill="none" stroke="#33423a" strokeWidth="2.4" />
              <path d="M-20 20l40-40" stroke="#55694a" strokeWidth="3.4" strokeLinecap="round" />
            </g>
          ) : (
            <g transform="translate(120 74)">
              <circle r="24" fill="#e2869e" opacity="0.18" />
              <circle r="13" fill="#e2869e" opacity="0.32" />
              <circle r="7" fill="#55694a" stroke="#ffffff" strokeWidth="3" />
            </g>
          )}
        </>
      )}
    </svg>
  );
}

export function EmptyState({ variant, title, children, action }: { variant: Variant; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`lempty lempty--${variant}`} aria-live={variant === 'find' ? undefined : 'polite'}>
      <LabsDrawing variant={variant} />
      <h2>{title}</h2>
      {children && <p className="lempty__text">{children}</p>}
      {action && <div className="lempty__action">{action}</div>}
    </section>
  );
}
