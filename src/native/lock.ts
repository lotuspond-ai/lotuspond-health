// App lock on iOS / Android: binds the lock controller (src/lib/applock.ts) to the biometric and
// privacy-screen plugins, with its settings in a small file next to the app's data.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { AndroidBiometryStrength, BiometricAuth, BiometryType, type CheckBiometryResult } from '@aparajita/capacitor-biometric-auth';
import { PrivacyScreen } from '@capacitor/privacy-screen';
import { createAppLock, DEFAULT_LOCK, LOCK_DELAYS, type AppLock, type Biometry, type LockSettings, type LockState } from '../lib/applock';
import { fileOps } from './storage';
import { isNative, platform } from './platform';

const DIR = 'lotuspond';
const FILE = `${DIR}/settings.json`;

function methodName(r: CheckBiometryResult): string {
  if (platform === 'ios') return r.biometryType === BiometryType.faceId ? 'Face ID' : r.biometryType === BiometryType.touchId ? 'Touch ID' : 'passcode';
  if (!r.isAvailable) return 'screen lock';
  return r.biometryType === BiometryType.fingerprintAuthentication ? 'fingerprint'
    : r.biometryType === BiometryType.faceAuthentication ? 'face unlock' : 'biometrics';
}

function parseSettings(text: string): LockSettings | 'unreadable' {
  try {
    const v = JSON.parse(text) as { lock?: Partial<LockSettings> };
    const lock = v?.lock;
    if (!lock || typeof lock.enabled !== 'boolean') return 'unreadable';
    const delayMs = (LOCK_DELAYS as readonly number[]).includes(lock.delayMs as number) ? lock.delayMs as LockSettings['delayMs'] : DEFAULT_LOCK.delayMs;
    return { enabled: lock.enabled, delayMs };
  } catch { return 'unreadable'; }
}

function createNativeLock(): AppLock {
  return createAppLock({
    async loadSettings() {
      await fileOps.ensureDir(DIR);
      if (!(await fileOps.list(DIR)).includes('settings.json')) return null;
      return parseSettings(await fileOps.readText(FILE));
    },
    async saveSettings(lock) {
      await fileOps.writeText(FILE, JSON.stringify({ lock }));
    },
    async checkBiometry(): Promise<Biometry> {
      const r = await BiometricAuth.checkBiometry();
      return { available: r.isAvailable, deviceSecure: r.deviceIsSecure, method: methodName(r) };
    },
    async authenticate(reason) {
      await BiometricAuth.authenticate({
        reason,
        cancelTitle: 'Cancel',
        // Fall back to the device passcode / screen lock so a failed face or finger never locks anyone out.
        allowDeviceCredential: true,
        androidTitle: 'Unlock LotusPond Health',
        androidSubtitle: reason,
        androidConfirmationRequired: false,
        androidBiometryStrength: AndroidBiometryStrength.weak,
      });
    },
    async setPrivacyScreen(on) {
      // iOS shows the launch screen in the app switcher; Android does the same and blocks screenshots (FLAG_SECURE).
      if (on) await PrivacyScreen.enable({ android: { dimBackground: false }, ios: { blurEffect: 'none' } });
      else await PrivacyScreen.disable();
    },
    now: () => Date.now(),
  });
}

/** The app lock, or null in a browser (there is no lock on the web). */
export const appLock: AppLock | null = isNative ? createNativeLock() : null;

const openState = createStore<LockState>()(() => ({ status: 'open', settings: DEFAULT_LOCK, biometry: null, message: null }));

/** Lock state for components; always "open" in a browser. */
export function useLock<T>(select: (s: LockState) => T): T {
  return useStore(appLock?.store ?? openState, select);
}
