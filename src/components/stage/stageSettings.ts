// Stage preferences: which view of the body map is shown, and how the interactive 3D view renders.
// Kept free of three.js so the default (2D) view never loads it.
import { create } from 'zustand';

export type StageMode = 'map' | '3d';

/**
 * Rendering tier of the interactive 3D stage, cheapest first. The stage starts at a tier that suits the device
 * and steps down when frames take too long (see src/three/AdaptiveQuality.tsx). Independently of the tier,
 * multisampling is used only on screens with a pixel ratio below 1.5.
 *   0  standard materials, pixel ratio 1
 *   1  standard materials, pixel ratio up to 1.25
 *   2  physical (clearcoat and sheen) materials, pixel ratio up to 1.5
 *   3  studio: tier 2 plus the reflective water floor, bloom and SMAA (only while "Studio light" is on)
 */
export type Tier = 0 | 1 | 2 | 3;

const KEY = 'lotuspond.stage';

interface Stored { mode?: StageMode; studio?: boolean; glow?: boolean }

function load(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Stored;
    return { mode: v.mode === '3d' ? '3d' : 'map', studio: v.studio === true, glow: v.glow !== false };
  } catch { return {}; }
}

function save(v: Stored) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode or storage blocked: keep the choice for this visit */ }
}

/** Phones and small laptops start one tier lower. */
export const lowPowerDevice = typeof navigator !== 'undefined'
  && ((navigator.hardwareConcurrency ?? 8) <= 4 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent));

interface StageSettings {
  mode: StageMode;
  /** "Studio light": reflective floor and effects, when the device keeps up. */
  studio: boolean;
  /** "Glow" look of the body map (the default): a quiet figure with soft halos per organ and a grade per body system. */
  glow: boolean;
  /** Current tier, set by the 3D stage. */
  tier: Tier;
  /** Highest tier the device has kept up with; the stage does not climb above it again. */
  ceiling: Tier;
  setMode: (m: StageMode) => void;
  setStudio: (on: boolean) => void;
  setGlow: (on: boolean) => void;
  setTier: (t: Tier, ceiling?: Tier) => void;
}

/** ?tier=0…3 pins the tier and turns adaptation off (for measuring and comparing tiers). */
const pinned = (() => {
  try { const t = Number(new URLSearchParams(location.search).get('tier') ?? NaN); return t >= 0 && t <= 3 ? (Math.floor(t) as Tier) : null; }
  catch { return null; }
})();
export const tierPinned = pinned !== null;

const stored = load();
const startTier = (studio: boolean): Tier => pinned ?? (studio ? 3 : lowPowerDevice ? 1 : 2);

export const useStage = create<StageSettings>((set, get) => ({
  mode: stored.mode ?? 'map',
  studio: stored.studio ?? false,
  glow: stored.glow ?? true,
  tier: startTier(stored.studio ?? false),
  ceiling: 3,
  setMode: mode => { set({ mode }); save({ mode, studio: get().studio, glow: get().glow }); },
  setStudio: studio => {
    const { ceiling } = get();
    set({ studio, tier: Math.min(startTier(studio), studio ? 3 : ceiling) as Tier });
    save({ mode: get().mode, studio, glow: get().glow });
  },
  setGlow: glow => { set({ glow }); save({ mode: get().mode, studio: get().studio, glow }); },
  setTier: (tier, ceiling) => set(s => ({ tier, ceiling: ceiling ?? s.ceiling })),
}));
