// Stage preferences: which view of the body map is shown, and how the interactive 3D view renders.
// Kept free of three.js so the default (2D) view never loads it.
import { create } from 'zustand';
import { isBody, type Body, type BodyChoice } from '../../lib/body.ts';

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

/** bodies: per profile id, the body chosen on this device instead of following the profile's sex. */
interface Stored { mode?: StageMode; studio?: boolean; glow?: boolean; bodies?: Record<string, Body> }

function load(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Stored;
    const bodies: Record<string, Body> = {};
    if (v.bodies && typeof v.bodies === 'object') for (const [id, b] of Object.entries(v.bodies)) if (isBody(b)) bodies[id] = b;
    return { mode: v.mode === '3d' ? '3d' : 'map', studio: v.studio === true, glow: v.glow !== false, bodies };
  } catch { return {}; }
}

function save(v: Required<Stored>) {
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
  /** Body chosen on this device per profile id; a missing entry follows the profile's sex. */
  bodies: Record<string, Body>;
  setMode: (m: StageMode) => void;
  setBody: (profileId: string, choice: BodyChoice) => void;
  /** Drop the choices kept for these profiles (deleted profiles, or a deleted account's). */
  forgetBodies: (profileIds: string[]) => void;
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

export const useStage = create<StageSettings>((set, get) => {
  // One writer for every persisted field, so changing one setting never drops another. Body choices are read back
  // from storage first and changed one profile at a time, so another open tab's choices are not overwritten.
  const persist = (change?: (bodies: Record<string, Body>) => void) => {
    const bodies = { ...(load().bodies ?? get().bodies) };
    change?.(bodies);
    set({ bodies });
    const { mode, studio, glow } = get();
    save({ mode, studio, glow, bodies });
  };
  // a choice made in another tab applies here too
  if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (e.key === KEY) set({ bodies: load().bodies ?? {} }); });
  return {
    mode: stored.mode ?? 'map',
    studio: stored.studio ?? false,
    glow: stored.glow ?? true,
    tier: startTier(stored.studio ?? false),
    ceiling: 3,
    bodies: stored.bodies ?? {},
    setMode: mode => { set({ mode }); persist(); },
    setStudio: studio => {
      const { ceiling } = get();
      set({ studio, tier: Math.min(startTier(studio), studio ? 3 : ceiling) as Tier });
      persist();
    },
    setGlow: glow => { set({ glow }); persist(); },
    setBody: (profileId, choice) => persist(bodies => { if (choice === 'profile') delete bodies[profileId]; else bodies[profileId] = choice; }),
    forgetBodies: profileIds => persist(bodies => { for (const id of profileIds) delete bodies[id]; }),
    setTier: (tier, ceiling) => set(s => ({ tier, ceiling: ceiling ?? s.ceiling })),
  };
});
