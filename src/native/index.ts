// Native app shell (iOS / Android via Capacitor). Does nothing in a browser.
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { SplashScreen } from '@capacitor/splash-screen';
import { useHealth } from '../lib/store';
import { useSession } from '../state/session';
import { useUI } from '../state/ui';
import { goBack } from '../state/navigation';
import { isNative, platform } from './platform';
import { appLock } from './lock';

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/** Light tap for selections; skipped where the device has no haptics. */
export const tick = () => { if (isNative) quiet(Haptics.impact({ style: ImpactStyle.Light })); };

/** Resolves when saved records may load: right away in a browser, once the app lock allows it in the apps. */
export const sessionReady: Promise<void> = appLock?.ready ?? Promise.resolve();

export function initNative(): void {
  if (!isNative) return;
  document.documentElement.classList.add('native', `native--${platform}`);

  // The app lock decides whether to start locked; the session (and with it the records) only loads once unlocked
  // (see sessionReady, used by App).
  quiet(App.addListener('pause', () => appLock?.onPause()));
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

  // Keep the launch screen up until the session check has answered, so the first frame shows sign-in or the app.
  // When the app starts locked, hide it straight away instead, so the lock screen and the Face ID prompt show.
  const hideSplash = () => requestAnimationFrame(() => quiet(SplashScreen.hide({ fadeOutDuration: 250 })));
  void (async () => {
    if (appLock && (await appLock.start()) !== 'open') { hideSplash(); void appLock.unlock(); }
    if (useSession.getState().status !== 'loading') { hideSplash(); return; }
    const stop = useSession.subscribe(s => { if (s.status !== 'loading') { stop(); hideSplash(); } });
  })();
}
