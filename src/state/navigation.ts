import { useHealth } from '../lib/store';
import { useUI } from './ui';

/**
 * Close whatever is on top: scan viewer, marker details, upload, then the open organ, then the current tab.
 * Used by the Android back button. Returns false when already at the whole-body view.
 */
export function goBack(): boolean {
  const ui = useUI.getState();
  const health = useHealth.getState();
  if (ui.scanOpen) { ui.setScanOpen(null); return true; }
  if (health.selectedMarkerId) { health.selectMarker(null); return true; }
  if (ui.uploadOpen) { ui.setUploadOpen(false); return true; }
  if (ui.view !== 'body') { ui.setView('body'); return true; }
  if (health.selectedOrgan) { health.selectOrgan(null); return true; }
  if (health.activeSystem) { health.setActiveSystem(null); return true; }
  return false;
}
