// Lab bookings and results for the open profile (Find a lab → Home collection). Loaded when the profile changes
// and refreshed while something is in progress, so the screen follows the lab and shows results as they arrive.
import { create } from 'zustand';
import { backend, errorMessage, isPreview } from '../api';
import { LAB_BOOKING_REGIONS, type LabOrderView, type LabResultView } from '../../shared/lab-bundle';
import { useSession } from './session';
import { toast } from './toast';
import { useUI } from './ui';

/** Statuses where the lab is still working on the order, so the screen keeps checking. */
const ACTIVE = new Set<LabOrderView['status']>(['created', 'payment_pending', 'paid', 'placing', 'booked', 'collector_assigned', 'sample_collected', 'recollection_needed', 'processing', 'partial_report']);

interface LabState {
  profileId: string | null;
  orders: LabOrderView[];
  results: LabResultView[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Find a lab's two halves: home collection (where booking is available) and labs near a place. */
  tab: 'home' | 'near';
  /** The booking dialog, and the result being reviewed (closed by the Android back button too). */
  bookingOpen: boolean;
  reviewing: string | null;
  /** A booking an AI agent prepared (propose_lab_booking), waiting for the person to review and confirm. */
  proposal: AgentProposal | null;
  setProposal: (p: AgentProposal | null) => void;
  load: (profileId: string | null) => Promise<void>;
  /** Check again quietly (a failed check keeps what is shown). */
  refresh: () => Promise<void>;
  /** Load again after an error, showing progress. */
  retry: () => Promise<void>;
  upsertOrder: (o: LabOrderView) => void;
  setTab: (t: 'home' | 'near') => void;
  setBookingOpen: (v: boolean) => void;
  setReviewing: (id: string | null) => void;
}

export interface AgentProposal { profileId: string; codes: string[]; pincode: string; reason: string | null }

/**
 * An agent's proposal from the link it shared (/app?book=CODE&profile=ID&pincode=NNNNNN&reason=…#labs), removed from
 * the address once read so a reload does not offer it again.
 */
export function readAgentProposal(): AgentProposal | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  const codes = (q.get('book') ?? '').split(',').map(s => s.trim()).filter(s => /^[\w.-]{1,60}$/.test(s)).slice(0, 10);
  const profileId = q.get('profile') ?? '';
  const pincode = q.get('pincode') ?? '';
  if (!codes.length || !/^[0-9a-f-]{36}$/i.test(profileId) || !/^\d{6}$/.test(pincode)) return null;
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
  return { profileId, codes, pincode, reason: q.get('reason')?.slice(0, 200) || null };
}

/** Whether the signed-in account can book home collection (a partner serves its region and there is a server). */
export function labBookingAvailable(): boolean {
  const region = useSession.getState().account?.region;
  return !isPreview && !!region && LAB_BOOKING_REGIONS.includes(region);
}

export const useLab = create<LabState>((set, get) => {
  let ticket = 0;
  async function fetchFor(profileId: string, quiet: boolean) {
    const mine = ++ticket;
    if (!quiet) set({ status: 'loading', error: null });
    try {
      const [orders, results] = await Promise.all([backend.labOrders(profileId), backend.labResults(profileId)]);
      if (mine !== ticket || get().profileId !== profileId) return;
      // Say so when results arrive while the app is open (not for those already waiting when it opened).
      const known = new Set(get().results.map(r => r.id));
      if (quiet && get().status === 'ready' && results.some(r => r.status === 'pending' && !known.has(r.id))) {
        toast.info(useUI.getState().view === 'labs' ? 'Lab results are ready to check.' : 'Lab results are ready to check. Open Find a lab to add them.');
      }
      set({ orders, results, status: 'ready', error: null });
    } catch (e) {
      if (mine === ticket && !quiet) set({ status: 'error', error: errorMessage(e) });
    }
  }
  return {
    profileId: null,
    orders: [],
    results: [],
    status: 'idle',
    error: null,
    tab: 'home',
    bookingOpen: false,
    reviewing: null,
    proposal: null,
    setProposal: proposal => set({ proposal }),
    load: async profileId => {
      if (profileId === get().profileId && get().status !== 'idle') return;
      set({ profileId, orders: [], results: [], status: 'idle', error: null, bookingOpen: false, reviewing: null });
      if (profileId && labBookingAvailable()) await fetchFor(profileId, false);
    },
    refresh: async () => {
      const { profileId } = get();
      if (profileId && labBookingAvailable()) await fetchFor(profileId, true);
    },
    retry: async () => {
      const { profileId } = get();
      if (profileId && labBookingAvailable()) await fetchFor(profileId, false);
    },
    upsertOrder: o => set(s => ({ orders: [o, ...s.orders.filter(x => x.id !== o.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })),
    setTab: tab => set({ tab }),
    setBookingOpen: bookingOpen => set({ bookingOpen }),
    setReviewing: reviewing => set({ reviewing }),
  };
});

/** How often to check again: every 5 s while the lab is working on something, else every minute. */
export function refreshInterval(orders: LabOrderView[]): number {
  return orders.some(o => ACTIVE.has(o.status)) ? 5000 : 60_000;
}
