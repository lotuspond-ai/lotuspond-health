import { create } from 'zustand';
import type { OrganId } from '../types';

export type View = 'body' | 'markers' | 'scans' | 'files' | 'sources' | 'profile' | 'account' | 'labs';
export const VIEWS: View[] = ['body', 'markers', 'scans', 'files', 'sources', 'profile', 'account', 'labs'];
export type SectionAxis = 'coronal' | 'sagittal' | 'transverse';
export type Quality = 'high' | 'fast';

interface UIState {
  view: View;
  hovered: OrganId | null;
  layers: { skin: boolean; skeleton: boolean; labels: boolean };
  xray: boolean;
  section: { on: boolean; axis: SectionAxis; depth: number };
  quality: Quality;
  uploadOpen: boolean;
  /** A saved file to read in the upload review (a report sent on WhatsApp, or Read results in Files). */
  review: ReviewTarget | null;
  addProfileOpen: boolean;
  scanOpen: string | null;
  /** Pixels of the 3D stage covered by the phone bottom sheet; the camera re-centres on the visible part. */
  stageInset: number;
  setView: (v: View) => void;
  setHovered: (o: OrganId | null) => void;
  toggleLayer: (k: keyof UIState['layers']) => void;
  setXray: (v: boolean) => void;
  setSection: (p: Partial<UIState['section']>) => void;
  setQuality: (q: Quality) => void;
  setUploadOpen: (v: boolean) => void;
  openReview: (r: ReviewTarget) => void;
  setAddProfileOpen: (v: boolean) => void;
  setScanOpen: (id: string | null) => void;
  setStageInset: (px: number) => void;
}

export interface ReviewTarget { profileId: string; documentId: string }

/** /app?review=DOC&profile=ID (the link WhatsApp replies with), removed from the address once read. */
export function readReviewLink(): ReviewTarget | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  const documentId = q.get('review') ?? '';
  const profileId = q.get('profile') ?? '';
  const id = /^[0-9a-f-]{36}$/i;
  if (!id.test(documentId) || !id.test(profileId)) return null;
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
  return { profileId, documentId };
}

const lowPower = typeof navigator !== 'undefined' && ((navigator.hardwareConcurrency ?? 8) <= 4 || /Mobi|Android/i.test(navigator.userAgent));

export const useUI = create<UIState>(set => ({
  view: 'body',
  hovered: null,
  layers: { skin: true, skeleton: true, labels: true },
  xray: false,
  section: { on: false, axis: 'coronal', depth: 0.5 },
  quality: lowPower ? 'fast' : 'high',
  uploadOpen: false,
  review: null,
  addProfileOpen: false,
  scanOpen: null,
  stageInset: 0,
  setView: view => {
    set({ view });
    if (typeof history !== 'undefined' && location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  },
  setHovered: hovered => set({ hovered }),
  toggleLayer: k => set(s => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  setXray: xray => set({ xray }),
  setSection: p => set(s => ({ section: { ...s.section, ...p } })),
  setQuality: quality => set({ quality }),
  setUploadOpen: uploadOpen => set(uploadOpen ? { uploadOpen } : { uploadOpen, review: null }),
  openReview: review => set({ review, uploadOpen: true }),
  setAddProfileOpen: addProfileOpen => set({ addProfileOpen }),
  setScanOpen: scanOpen => set({ scanOpen }),
  setStageInset: stageInset => set({ stageInset }),
}));
