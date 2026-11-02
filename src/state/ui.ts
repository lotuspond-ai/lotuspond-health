import { create } from 'zustand';
import type { OrganId } from '../types';

export type View = 'body' | 'markers' | 'scans';
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
  scanOpen: string | null;
  setView: (v: View) => void;
  setHovered: (o: OrganId | null) => void;
  toggleLayer: (k: keyof UIState['layers']) => void;
  setXray: (v: boolean) => void;
  setSection: (p: Partial<UIState['section']>) => void;
  setQuality: (q: Quality) => void;
  setUploadOpen: (v: boolean) => void;
  setScanOpen: (id: string | null) => void;
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
  scanOpen: null,
  setView: view => set({ view }),
  setHovered: hovered => set({ hovered }),
  toggleLayer: k => set(s => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  setXray: xray => set({ xray }),
  setSection: p => set(s => ({ section: { ...s.section, ...p } })),
  setQuality: quality => set({ quality }),
  setUploadOpen: uploadOpen => set({ uploadOpen }),
  setScanOpen: scanOpen => set({ scanOpen }),
}));
