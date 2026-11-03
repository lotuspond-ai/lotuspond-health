import { create } from 'zustand';
import type { OrganId } from '../types';

export type View = 'body' | 'markers' | 'scans' | 'files' | 'profile' | 'account' | 'labs';
export const VIEWS: View[] = ['body', 'markers', 'scans', 'files', 'profile', 'account', 'labs'];
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
  setAddProfileOpen: (v: boolean) => void;
  setScanOpen: (id: string | null) => void;
  setStageInset: (px: number) => void;
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
  setUploadOpen: uploadOpen => set({ uploadOpen }),
  setAddProfileOpen: addProfileOpen => set({ addProfileOpen }),
  setScanOpen: scanOpen => set({ scanOpen }),
  setStageInset: stageInset => set({ stageInset }),
}));
