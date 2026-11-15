import { useHealth } from '../lib/store';
import { useSession } from './session';
import { useUI } from './ui';
import { useLab } from './lab';

/**
 * Close whatever is on top: scan viewer, marker details, upload, add-a-family-member, then the open organ or system
 * filter on the body map, then go back to Home. Used by the Android back button. Returns false when there is nothing
 * left to close (Home, or the sign-in screen), so the app goes to the background.
 */
export function goBack(): boolean {
  if (useSession.getState().status !== 'signed-in' || useSession.getState().onboarding) return false;
  const ui = useUI.getState();
  const health = useHealth.getState();
  if (ui.scanOpen) { ui.setScanOpen(null); return true; }
  const lab = useLab.getState();
  if (lab.reviewing) { lab.setReviewing(null); return true; }
  if (lab.bookingOpen) { lab.setBookingOpen(false); return true; }
  if (health.selectedMarkerId) { health.selectMarker(null); return true; }
  if (ui.uploadOpen) { ui.setUploadOpen(false); return true; }
  if (ui.addProfileOpen) { ui.setAddProfileOpen(false); return true; }
  if (ui.view === 'body' && health.selectedOrgan) { health.selectOrgan(null); return true; }
  if (ui.view === 'body' && health.activeSystem) { health.setActiveSystem(null); return true; }
  if (ui.view !== 'home') { ui.setView('home'); return true; }
  return false;
}
