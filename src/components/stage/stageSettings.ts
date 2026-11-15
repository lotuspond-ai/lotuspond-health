// Body map preferences kept on this device.
import { create } from 'zustand';

const KEY = 'lotuspond.stage';

interface Stored { glow?: boolean }

function load(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Stored;
    return { glow: v.glow !== false };
  } catch { return {}; }
}

function save(v: Stored) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode or storage blocked: keep the choice for this visit */ }
}

interface StageSettings {
  /** "Glow" look of the body map (the default): a quiet figure with soft halos per organ and a grade per body system. */
  glow: boolean;
  setGlow: (on: boolean) => void;
}

export const useStage = create<StageSettings>(set => ({
  glow: load().glow ?? true,
  setGlow: glow => { set({ glow }); save({ glow }); },
}));
