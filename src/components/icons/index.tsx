// Small line icons for the result views: body systems, result status, scan types and file types.
// One visual language: 24px grid, 1.8 stroke, round caps and joins, currentColor.
import type { ReactNode } from 'react';
import type { Status, SystemId } from '../../types';
import { FILE_LABEL, fileFamily, modalityFamily, modalityLabel, type FileFamily, type Modality } from './kinds';

function Svg({ children, size = 20, className }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">{children}</svg>
  );
}

const SYSTEM_PATHS: Record<SystemId | 'other', ReactNode> = {
  // heart with a pulse line
  heart: <><path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10z" /><path d="M7.5 12.2h2.3l1.2-2 1.8 4 1.1-2h2.6" /></>,
  // sugar cube
  metabolic: <><path d="M12 3.8l7 3.6v8.2l-7 3.6-7-3.6V7.4z" /><path d="M5 7.4l7 3.6 7-3.6M12 11v8.6" /></>,
  // liver lobes
  liver: <><path d="M3.8 9.6c0-2.4 2.3-3.6 5.4-3.6 3.9 0 7.4-.9 9.6-.9 1.7 0 1.9 1.6 1.1 3-1.6 2.8-4.9 6.4-9 8.6-2.6 1.4-4.5 1.2-5.6-.8-1-1.8-1.5-4-1.5-6.3z" /><path d="M12.4 6.2c-.6 2.7-.4 5.6.6 8.2" /></>,
  // kidney bean with ureter
  kidney: <><path d="M14.6 4.6c-3.4-1.4-7.6.6-8.6 4.8-1 4.1.9 8.6 4.6 9.8 2.5.8 4.2-.6 3.9-2.6-.2-1.5-1.4-2.2-1.4-3.8 0-1.4 1.3-2 2.3-3.2 1.4-1.8.9-4.1-.8-5z" /><path d="M12.9 12.5h3.2l2.6 6.9" /></>,
  // blood drop
  blood: <><path d="M12 3.5s6 6.6 6 10.9a6 6 0 0 1-12 0C6 10.1 12 3.5 12 3.5z" /><path d="M9.3 14.6a2.8 2.8 0 0 0 2.6 2.7" /></>,
  // thyroid butterfly
  thyroid: <><path d="M10.6 11.2C9.9 7.4 8.6 5 6.8 5 4.6 5 4 8.4 4.5 12c.5 3.6 2.2 6.4 4.3 6.4 1.6 0 2.1-2 1.8-4.2z" /><path d="M13.4 11.2C14.1 7.4 15.4 5 17.2 5c2.2 0 2.8 3.4 2.3 7-.5 3.6-2.2 6.4-4.3 6.4-1.6 0-2.1-2-1.8-4.2z" /><path d="M10.6 12.6h2.8" /></>,
  // capsule
  nutrition: <><rect x="3.2" y="8.6" width="17.6" height="6.8" rx="3.4" transform="rotate(-38 12 12)" /><path d="M9.9 9.2l4.2 5.6" /></>,
  // flame
  inflammation: <><path d="M12 20.5c3.6 0 6-2.5 6-5.9 0-3.8-3-5.8-3.8-9.6-1.9 1.4-2.8 3.2-2.8 5-1.2-.6-2-1.8-2.2-3.1C7.4 8.6 6 11 6 14.6c0 3.4 2.4 5.9 6 5.9z" /><path d="M12 20.5c-1.5 0-2.6-1-2.6-2.6 0-1.7 1.6-2.6 2.2-4.2 1.4 1 3 2.4 3 4.2 0 1.6-1.1 2.6-2.6 2.6z" /></>,
  // molecule
  hormones: <><path d="M12 4.2l6.5 3.7v7.4L12 19l-6.5-3.7V7.9z" /><circle cx="12" cy="11.6" r="2.3" /><path d="M12 4.2v5.1M18.5 15.3l-4.5-2.6M5.5 15.3l4.5-2.6" /></>,
  // specimen cup
  urine: <><path d="M6.5 8.5h11l-1.2 10.2a1.6 1.6 0 0 1-1.6 1.4H9.3a1.6 1.6 0 0 1-1.6-1.4z" /><path d="M5.5 5.2h13v3.3h-13z" /><path d="M8.2 13.2c1.2-.7 2.4-.7 3.8 0s2.6.7 3.8 0" /></>,
  // gauge with a needle (blood pressure cuff dial)
  vitals: <><circle cx="12" cy="13" r="7.5" /><path d="M12 13l3.6-3.4M7.6 13h1.2M15.2 13h1.2M12 8.6v1.2" /><path d="M10 3.8h4" /></>,
  // flask for anything unmatched
  other: <><path d="M9.5 3.8h5M10.3 3.8v5.4L5.4 17.8a1.6 1.6 0 0 0 1.4 2.4h10.4a1.6 1.6 0 0 0 1.4-2.4l-4.9-8.6V3.8" /><path d="M7.8 14.2h8.4" /></>,
};

/** Icon for a body system (biomarker group). */
export function SystemIcon({ system, size }: { system: SystemId | 'other'; size?: number }) {
  return <Svg size={size}>{SYSTEM_PATHS[system] ?? SYSTEM_PATHS.other}</Svg>;
}

const STATUS_PATHS: Record<Status, ReactNode> = {
  normal: <path d="M7.5 12.4l3 3 6-6.4" />,
  high: <path d="M12 17V7.5M7.8 11.5L12 7.3l4.2 4.2" />,
  low: <path d="M12 7v9.5M7.8 12.5l4.2 4.2 4.2-4.2" />,
  unknown: <path d="M8 12h8" />,
};

/** Status glyph: tick for in range, arrows for above and below, dash for no range. Always shown with a label. */
export function StatusIcon({ status, size = 16 }: { status: Status; size?: number }) {
  return <Svg size={size}><circle cx="12" cy="12" r="9" />{STATUS_PATHS[status]}</Svg>;
}

/** Plain arrow used inside count chips. */
export function ArrowIcon({ dir, size = 12 }: { dir: 'up' | 'down'; size?: number }) {
  return <Svg size={size}>{dir === 'up' ? <path d="M12 19V5M6 11l6-6 6 6" /> : <path d="M12 5v14M6 13l6 6 6-6" />}</Svg>;
}

const MODALITY_PATHS: Record<Modality, ReactNode> = {
  xray: <><path d="M12 4v16" /><path d="M12 7.5c-2.5 0-4.6.6-6 1.8M12 7.5c2.5 0 4.6.6 6 1.8M12 11c-2.5 0-4.6.6-6 1.8M12 11c2.5 0 4.6.6 6 1.8M12 14.5c-2.2 0-4 .5-5.2 1.5M12 14.5c2.2 0 4 .5 5.2 1.5" /></>,
  ct: <><circle cx="12" cy="11" r="7" /><circle cx="12" cy="11" r="3" /><path d="M4 20h16" /></>,
  mri: <><path d="M5 17V9a7 7 0 0 1 14 0v8" /><path d="M8.5 17v-7a3.5 3.5 0 0 1 7 0v7" /><path d="M3.5 17h17" /></>,
  us: <><path d="M12 5L5.2 16.6a12 12 0 0 0 13.6 0z" /><path d="M8.6 13.6a6 6 0 0 0 6.8 0M10.3 10.6a3 3 0 0 0 3.4 0" /></>,
  photo: <><path d="M4 8.5a1.5 1.5 0 0 1 1.5-1.5h2.2L9.2 5h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="12.8" r="3.3" /></>,
  scan: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="M4 12h16" /><circle cx="12" cy="12" r="4" /></>,
};

/** Icon for a scan's modality. */
export function ModalityIcon({ modality, size }: { modality?: string | null; size?: number }) {
  return <Svg size={size}>{MODALITY_PATHS[modalityFamily(modality)]}</Svg>;
}

/** Small badge with the modality icon and a short label, for scan thumbnails. */
export function ModalityBadge({ modality }: { modality?: string | null }) {
  return <span className="mod-badge"><ModalityIcon modality={modality} size={13} />{modalityLabel(modality)}</span>;
}

/** Short type label for a stored file, e.g. "PDF" or "DICOM". */
export function FileTypeLabel({ fileName, contentType }: { fileName: string; contentType: string }) {
  return <>{FILE_LABEL[fileFamily(fileName, contentType)]}</>;
}

/** Document-shaped icon with a mark for the file type. */
export function FileTypeIcon({ fileName, contentType, size = 28 }: { fileName: string; contentType: string; size?: number }) {
  const fam = fileFamily(fileName, contentType);
  const inner: Record<FileFamily, ReactNode> = {
    pdf: <path d="M8.5 12.5h7M8.5 15.5h7M8.5 18h4" />,
    table: <path d="M8 12h8v6.5H8zM8 15.2h8M12 12v6.5" />,
    code: <path d="M10 12l-2 2.6 2 2.6M14 12l2 2.6-2 2.6" />,
    dicom: <><circle cx="12" cy="15.2" r="3.2" /><circle cx="12" cy="15.2" r="1" /></>,
    image: <><circle cx="9.6" cy="12.6" r="1.2" /><path d="M7.5 18.5l3.5-3.5 2 2 1.5-1.5 2 3" /></>,
    file: <path d="M8.5 13h7M8.5 16h5" />,
  };
  return <Svg size={size}><path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z" /><path d="M14 3v4.5h4.5" />{inner[fam]}</Svg>;
}

/** Interface glyphs used by the result views. */
export function UiIcon({ name, size = 18 }: { name: 'pin' | 'calendar' | 'grid' | 'list' | 'search' | 'scan' | 'flask' | 'chart' | 'layers' | 'info'; size?: number }) {
  const p: Record<typeof name, ReactNode> = {
    pin: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></>,
    calendar: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
    grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>,
    list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
    search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
    scan: MODALITY_PATHS.scan,
    flask: SYSTEM_PATHS.other,
    chart: <path d="M4 19h16M6.5 15l4-4.5 3 3L19 7" />,
    layers: <><path d="M12 4l8 4.2-8 4.2-8-4.2z" /><path d="M4 12.4l8 4.2 8-4.2M4 16.3l8 4.2 8-4.2" /></>,
    info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8h.01" /></>,
  };
  return <Svg size={size}>{p[name]}</Svg>;
}
