import { useHealth } from '../lib/store';
import { useSession } from './session';
import { useUI } from './ui';

/**
 * Close whatever is on top: scan viewer, marker details, upload, add-a-family-member, then go back to the body map,
 * then close the open organ or system filter. Used by the Android back button. Returns false when there is nothing
 * left to close (the whole body, or the sign-in screen), so the app goes to the background.
 */
export function goBack(): boolean {
  if (useSession.getState().status !== 'signed-in' || useSession.getState().onboarding) return false;
  const ui = useUI.getState();
  const health = useHealth.getState();
  if (ui.scanOpen) { ui.setScanOpen(null); return true; }
  if (health.selectedMarkerId) { health.selectMarker(null); return true; }
  if (ui.uploadOpen) { ui.setUploadOpen(false); return true; }
  if (ui.addProfileOpen) { ui.setAddProfileOpen(false); return true; }
  if (ui.view !== 'body') { ui.setView('body'); return true; }
  if (health.selectedOrgan) { health.selectOrgan(null); return true; }
  if (health.activeSystem) { health.setActiveSystem(null); return true; }
  return false;
}
