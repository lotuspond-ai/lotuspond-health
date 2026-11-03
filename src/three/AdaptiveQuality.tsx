// Frame-time monitor for the 3D stage. With frameloop="demand" frames only render while something moves, so an
// fps counter would read idle time as slowness. Instead it samples the gap between frames that follow each other
// directly (a frame was requested from inside the previous one: camera damping, fades), and steps the rendering
// tier down when those gaps are long, or back up (a limited number of times) when there is room again.
import { useEffect, useRef } from 'react';
import { addAfterEffect, useThree, useFrame } from '@react-three/fiber';
import { tierPinned, useStage, type Tier } from '../components/stage/stageSettings';

const WINDOW = 16;       // samples per decision
const SLOW_MS = 38;      // median frame gap above this (about 26 fps) steps down
const SMOOTH_MS = 20;    // below this (display refresh) for several windows may step up
const SETTLE_MS = 1500;  // ignore frames right after a change while shaders compile
const MAX_RAISES = 2;

export function AdaptiveQuality({ active }: { active: boolean }) {
  const store = useThree(s => s.get);
  const tier = useStage(s => s.tier);
  const r = useRef({ last: 0, chained: false, samples: [] as number[], smooth: 0, raises: 0, settleUntil: 0 });

  // A new tier, or coming back into view: start a fresh measurement once things have settled.
  useEffect(() => {
    const st = r.current;
    st.samples.length = 0; st.smooth = 0; st.chained = false; st.settleUntil = performance.now() + SETTLE_MS;
  }, [tier, active]);

  useEffect(() => addAfterEffect(() => {
    // After rendering, R3F has already counted this frame off; anything left was requested during it.
    r.current.chained = store().internal.frames > 0;
  }), [store]);

  useFrame(() => {
    const st = r.current, now = performance.now();
    const gap = now - st.last;
    const sample = !tierPinned && st.chained && now > st.settleUntil && document.visibilityState === 'visible';
    st.last = now;
    if (!sample) return;
    st.samples.push(gap);
    if (st.samples.length < WINDOW) return;
    const sorted = [...st.samples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    st.samples.length = 0;
    const { tier: t, ceiling, studio, setTier } = useStage.getState();
    if (median > SLOW_MS && t > 0) {
      st.smooth = 0;
      setTier((t - 1) as Tier, t - 1 as Tier);
    } else if (median < SMOOTH_MS) {
      const top: Tier = studio ? 3 : 2;
      if (++st.smooth >= 4 && t < top && st.raises < MAX_RAISES) {
        st.smooth = 0; st.raises++;
        setTier((t + 1) as Tier, Math.max(ceiling, t + 1) as Tier);
      }
    } else st.smooth = 0;
  });
  return null;
}
