// Native app shell (iOS / Android via Capacitor). Does nothing in a browser.
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { SplashScreen } from '@capacitor/splash-screen';
import { flushPersist, holdHydration, hydrate, setStorageBackend, useHealth } from '../lib/store';
import { useUI } from '../state/ui';
import { goBack } from '../state/navigation';
import { isNative, platform } from './platform';
import { createNativeStorage } from './storage';
import { appLock } from './lock';

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/** Light tap for selections; skipped where the device has no haptics. */
export const tick = () => { if (isNative) quiet(Haptics.impact({ style: ImpactStyle.Light })); };

export function initNative(): void {
  if (!isNative) return;
  document.documentElement.classList.add('native', `native--${platform}`);

  // Save to app files rather than the WebView's IndexedDB (moved over on first launch).
  setStorageBackend(createNativeStorage());
  // With the app lock on, saved results stay out of memory until the user unlocks.
  if (appLock) holdHydration(appLock.ready);
  quiet(App.addListener('pause', () => {
    void flushPersist(); // write any pending change at once; the app may not get another chance
    appLock?.onPause();
  }));
  quiet(App.addListener('resume', () => appLock?.onResume()));

  // Status bar icons: dark over the light interface, light over the dark scan viewer and lock screen.
  const dark = () => !!useUI.getState().scanOpen || (appLock?.store.getState().status ?? 'open') !== 'open';
  const setBars = () => quiet(SystemBars.setStyle({ style: dark() ? SystemBarsStyle.Dark : SystemBarsStyle.Light }));
  setBars();
  appLock?.store.subscribe((s, prev) => { if (s.status !== prev.status) setBars(); });
  useUI.subscribe((s, prev) => {
    if (s.scanOpen !== prev.scanOpen) setBars();
    if (s.view !== prev.view) tick();
  });
  useHealth.subscribe((s, prev) => { if (s.selectedOrgan && s.selectedOrgan !== prev.selectedOrgan) tick(); });

  // Android back: close the top layer, then step out to the whole body, then leave the app (kept in memory).
  // On the lock screen it only leaves the app.
  quiet(App.addListener('backButton', () => {
    const locked = (appLock?.store.getState().status ?? 'open') !== 'open';
    if (locked || !goBack()) quiet(App.minimizeApp());
  }));

  // Data left in IndexedDB (scan files a migration could not copy) should survive low-storage clean-up too.
  if (navigator.storage?.persist) quiet(navigator.storage.persist());

  // Keep the launch screen up until saved data is loaded, so the first frame already shows it. When the app
  // starts locked, hide it straight away instead, so the lock screen and the Face ID prompt show.
  const hideSplash = () => requestAnimationFrame(() => quiet(SplashScreen.hide({ fadeOutDuration: 250 })));
  void (async () => {
    if (appLock && (await appLock.start()) !== 'open') { hideSplash(); void appLock.unlock(); }
    await hydrate();
    hideSplash();
  })();
}
