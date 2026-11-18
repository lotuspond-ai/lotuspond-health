import { create } from 'zustand';
import type { OrganId } from '../types';

export type View = 'home' | 'body' | 'markers' | 'scans' | 'files' | 'sources' | 'agents' | 'profile' | 'account' | 'labs' | 'console';
export const VIEWS: View[] = ['home', 'body', 'markers', 'scans', 'files', 'sources', 'agents', 'profile', 'account', 'labs', 'console'];
/** The views under Records: results, the body map, scans and files. */
export const RECORD_VIEWS: View[] = ['markers', 'body', 'scans', 'files'];

interface UIState {
  view: View;
  hovered: OrganId | null;
  layers: { labels: boolean };
  uploadOpen: boolean;
  /** A saved file to read in the upload review (a report sent on WhatsApp, or Read results in Files). */
  review: ReviewTarget | null;
  addProfileOpen: boolean;
  scanOpen: string | null;
  /** Pixels of the body map covered by the phone bottom sheet; the map re-centres on the visible part. */
  stageInset: number;
  setView: (v: View) => void;
  setHovered: (o: OrganId | null) => void;
  toggleLayer: (k: keyof UIState['layers']) => void;
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

export const useUI = create<UIState>(set => ({
  view: 'home',
  hovered: null,
  layers: { labels: true },
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
  setUploadOpen: uploadOpen => set(uploadOpen ? { uploadOpen } : { uploadOpen, review: null }),
  openReview: review => set({ review, uploadOpen: true }),
  setAddProfileOpen: addProfileOpen => set({ addProfileOpen }),
  setScanOpen: scanOpen => set({ scanOpen }),
  setStageInset: stageInset => set({ stageInset }),
}));
