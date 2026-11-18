// State for the Find a lab page: the point being searched, radius, filter and selection, plus data hooks.
// A point picked on the page lives here (in memory only); otherwise the open profile's saved home area is used.
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import type { FacilityKind, FacilitySearchResult, PublicConfig } from '../../types';
import { backend } from '../../api';
import { DEFAULT_RADIUS_KM } from '../../../shared/facilities';

export interface SearchPoint {
  lat: number;
  lon: number;
  label: string;
  country: string | null;
  postalCode: string | null;
  /** 'device': this device's position (precise, never saved as is). 'search': an area picked by name. 'saved': the home area. */
  source: 'device' | 'search' | 'saved';
}

export type KindFilter = 'all' | FacilityKind;

interface LabsState {
  /** A point picked on this page; null means "use the saved home area". */
  picked: SearchPoint | null;
  radiusKm: number;
  filter: KindFilter;
  selectedId: string | null;
  pick: (p: SearchPoint | null) => void;
  setRadius: (r: number) => void;
  setFilter: (f: KindFilter) => void;
  select: (id: string | null) => void;
}

export const useLabs = create<LabsState>(set => ({
  picked: null,
  radiusKm: DEFAULT_RADIUS_KM,
  filter: 'all',
  selectedId: null,
  pick: picked => set({ picked, selectedId: null }),
  setRadius: radiusKm => set({ radiusKm, selectedId: null }),
  setFilter: filter => set({ filter }),
  select: selectedId => set({ selectedId }),
}));

/* ---------- public config (map tiles) ---------- */

let configPromise: Promise<PublicConfig> | null = null;
let configValue: PublicConfig | null = null;

/** The server's public settings, loaded once (also used to tell whether lab booking is set up). */
export function loadConfig(): Promise<PublicConfig> {
  configPromise ??= backend.publicConfig().then(
    c => (configValue = c),
    () => { configPromise = null; return { map: null, nearbySearch: true }; },
  );
  return configPromise;
}

/** The settings if they have loaded, without waiting. */
export const publicConfigNow = (): PublicConfig | null => configValue;

/** Map settings from the server, or null while loading. */
export function usePublicConfig(): PublicConfig | null {
  const [cfg, setCfg] = useState<PublicConfig | null>(configValue);
  useEffect(() => {
    if (cfg) return;
    let live = true;
    void loadConfig().then(c => { if (live) setCfg(c); });
    return () => { live = false; };
  }, [cfg]);
  return cfg;
}

/* ---------- nearby search ---------- */

/** Answers already shown in this session, so returning to the page does not search again. */
const answers = new Map<string, FacilitySearchResult>();

export type NearbyStatus =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: FacilitySearchResult }
  | { status: 'error'; error: unknown };

export function useNearby(point: SearchPoint | null, radiusKm: number, country: string | null, enabled: boolean): NearbyStatus & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const lat = point?.lat, lon = point?.lon;
  const query = useMemo(() => (lat != null && lon != null && enabled ? { lat, lon, radiusKm, country } : null), [lat, lon, radiusKm, country, enabled]);
  const key = query ? `${query.lat.toFixed(5)},${query.lon.toFixed(5)}|${radiusKm}|${country ?? ''}|${attempt}` : null;
  // Set when a search finishes (a new object each time, so the component renders with the stored answer).
  const [settled, setSettled] = useState<{ key: string; error?: unknown } | null>(null);

  useEffect(() => {
    if (!key || !query || answers.has(key)) return;
    let live = true;
    backend.nearbyFacilities(query).then(
      data => {
        if (answers.size > 40) answers.delete(answers.keys().next().value!);
        answers.set(key, data);
        if (live) setSettled({ key });
      },
      error => { if (live) setSettled({ key, error: error ?? new Error('Search failed') }); },
    );
    return () => { live = false; };
  }, [key, query]);

  const retry = () => setAttempt(a => a + 1);
  if (!key) return { status: 'idle', retry };
  const data = answers.get(key);
  if (data) return { status: 'ready', data, retry };
  if (settled?.key === key && settled.error) return { status: 'error', error: settled.error, retry };
  return { status: 'loading', retry };
}
