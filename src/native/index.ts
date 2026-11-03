// Native app shell (iOS / Android via Capacitor). Does nothing in a browser.
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { SplashScreen } from '@capacitor/splash-screen';
import { flushPersist, hydrate, setStorageBackend, useHealth } from '../lib/store';
import { useUI } from '../state/ui';
import { goBack } from '../state/navigation';
import { isNative, platform } from './platform';
import { createNativeStorage } from './storage';

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/** Light tap for selections; skipped where the device has no haptics. */
export const tick = () => { if (isNative) quiet(Haptics.impact({ style: ImpactStyle.Light })); };

export function initNative(): void {
  if (!isNative) return;
  document.documentElement.classList.add('native', `native--${platform}`);

  // Save to app files rather than the WebView's IndexedDB (moved over on first launch).
  setStorageBackend(createNativeStorage());
  // Write any pending change at once when the app leaves the screen; it may not get another chance.
  quiet(App.addListener('pause', () => void flushPersist()));

  // Status bar icons: dark over the light interface, light over the dark full-screen scan viewer.
  const setBars = () => quiet(SystemBars.setStyle({ style: useUI.getState().scanOpen ? SystemBarsStyle.Dark : SystemBarsStyle.Light }));
  setBars();
  useUI.subscribe((s, prev) => {
    if (s.scanOpen !== prev.scanOpen) setBars();
    if (s.view !== prev.view) tick();
  });
  useHealth.subscribe((s, prev) => { if (s.selectedOrgan && s.selectedOrgan !== prev.selectedOrgan) tick(); });

  // Android back: close the top layer, then step out to the whole body, then leave the app (kept in memory).
  quiet(App.addListener('backButton', () => { if (!goBack()) quiet(App.minimizeApp()); }));

  // Data left in IndexedDB (scan files a migration could not copy) should survive low-storage clean-up too.
  if (navigator.storage?.persist) quiet(navigator.storage.persist());

  // Keep the launch screen up until saved data is loaded, so the first frame already shows it.
  void hydrate().finally(() => requestAnimationFrame(() => quiet(SplashScreen.hide({ fadeOutDuration: 250 }))));
}
