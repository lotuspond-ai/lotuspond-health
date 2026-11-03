// Icon path data for the Find a lab page (24×24, stroked). Used by <LabIcon> and by map markers, which are plain DOM.
import type { FacilityKind } from '../../types';

export const KIND_PATHS: Record<FacilityKind, string[]> = {
  lab: ['M9 3h6', 'M10 3v6.2L4.8 18.1A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-2.9L14 9.2V3', 'M7.3 15h9.4'],
  imaging: ['M4 8V5a1 1 0 0 1 1-1h3', 'M16 4h3a1 1 0 0 1 1 1v3', 'M20 16v3a1 1 0 0 1-1 1h-3', 'M8 20H5a1 1 0 0 1-1-1v-3', 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'],
  hospital: ['M6 3h12a2 2 0 0 1 2 2v16H4V5a2 2 0 0 1 2-2z', 'M12 7v6', 'M9 10h6', 'M10 21v-4h4v4'],
  clinic: ['M5 3v5a4 4 0 0 0 8 0V3', 'M9 12v2.5a5 5 0 0 0 10 0V13', 'M19 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
};

export const ICON_PATHS = {
  locate: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3'],
  pin: ['M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z', 'M12 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  search: ['M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M20 20l-4.2-4.2'],
  directions: ['M12 2.5l9.5 9.5-9.5 9.5L2.5 12z', 'M9 14.5V12a1 1 0 0 1 1-1h5', 'M13 8.5l2.5 2.5-2.5 2.5'],
  phone: ['M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z'],
  book: ['M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M8 3v4', 'M16 3v4', 'M4 10h16', 'M9 15l2 2 4-4'],
  home: ['M4 11l8-7 8 7', 'M6 9.5V20h12V9.5', 'M10 20v-5h4v5'],
  star: ['M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6l-5.4 2.9 1.2-6-4.5-4.2 6.1-.7z'],
  shield: ['M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z', 'M9 12l2 2 4-4'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  siren: ['M7 18v-6a5 5 0 0 1 10 0v6', 'M5 21h14v-3H5z', 'M12 2v2', 'M4.2 5.2l1.4 1.4', 'M19.8 5.2l-1.4 1.4'],
  cloudOff: ['M3 3l18 18', 'M8 7.6A6 6 0 0 1 17.7 10H18a4 4 0 0 1 2.5 7.1', 'M17 18H7a5 5 0 0 1-1.6-9.7'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  spinner: ['M12 3a9 9 0 1 0 9 9'],
} as const;

export type IconName = keyof typeof ICON_PATHS | FacilityKind;

export function iconPaths(name: IconName): readonly string[] {
  return name in KIND_PATHS ? KIND_PATHS[name as FacilityKind] : ICON_PATHS[name as keyof typeof ICON_PATHS];
}

/** SVG markup for a map marker (strings, because markers are created outside React). */
export function iconSvg(name: IconName): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths(name).map(d => `<path d="${d}"/>`).join('')}</svg>`;
}
