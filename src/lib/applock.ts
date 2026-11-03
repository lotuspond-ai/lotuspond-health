// App lock (Face ID / Touch ID / fingerprint, falling back to the device passcode) for the iOS and Android apps.
// The platform pieces are passed in (src/native/lock.ts binds them to Capacitor plugins), so this state
// machine has no platform imports and is tested in Node.
//
// What it protects: someone picking up the unlocked phone cannot open LotusPond. Saved results are only loaded
// once the app is unlocked. It does not add encryption beyond what the OS already applies to app files.
import { createStore, type StoreApi } from 'zustand/vanilla';

/** How long the app may be in the background before it locks again. */
export const LOCK_DELAYS = [0, 60_000, 300_000] as const;
export type LockDelay = (typeof LOCK_DELAYS)[number];

export interface LockSettings { enabled: boolean; delayMs: LockDelay }
export const DEFAULT_LOCK: LockSettings = { enabled: false, delayMs: 60_000 };

export interface Biometry {
  /** Face ID, Touch ID, fingerprint or face unlock is set up. */
  available: boolean;
  /** A device passcode / screen lock is set (needed for the fallback). */
  deviceSecure: boolean;
  /** What the user knows it as: "Face ID", "Touch ID", "fingerprint", "passcode"... */
  method: string;
}

export type LockStatus = 'starting' | 'locked' | 'authenticating' | 'open';

export interface LockState {
  status: LockStatus;
  settings: LockSettings;
  biometry: Biometry | null;
  /** Shown on the lock screen or next to the setting. */
  message: string | null;
}

export interface LockDeps {
  /** Saved settings, null when none were saved, 'unreadable' when a file exists but cannot be read. */
  loadSettings(): Promise<LockSettings | null | 'unreadable'>;
  saveSettings(s: LockSettings): Promise<void>;
  checkBiometry(): Promise<Biometry>;
  /** Resolves when the user proved who they are; rejects with an error carrying `code` otherwise. */
  authenticate(reason: string): Promise<void>;
  /** Hide the app's content in the app switcher (and, on Android, block screenshots). */
  setPrivacyScreen(on: boolean): Promise<void>;
  now(): number;
}

export interface AppLock {
  store: StoreApi<LockState>;
  /** Resolves once the app may show saved data: unlocked, or no lock set. */
  ready: Promise<void>;
  /** Read settings and decide whether to start locked. Returns the starting status. */
  start(): Promise<LockStatus>;
  /** Ask for Face ID / passcode. True when unlocked. */
  unlock(): Promise<boolean>;
  onPause(): void;
  onResume(): void;
  /** Turn the lock on or off; both need the user to authenticate. True when changed. */
  setEnabled(on: boolean): Promise<boolean>;
  setDelay(delayMs: LockDelay): Promise<void>;
}

const NO_BIOMETRY: Biometry = { available: false, deviceSecure: false, method: 'passcode' };
const errorCode = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');
const CANCELLED = new Set(['userCancel', 'systemCancel', 'appCancel']);
const NO_CREDENTIAL = new Set(['passcodeNotSet', 'noDeviceCredential', 'biometryNotAvailable', 'biometryNotEnrolled']);
const canAuthenticate = (b: Biometry) => b.available || b.deviceSecure;

export function createAppLock(deps: LockDeps): AppLock {
  const store = createStore<LockState>()(() => ({ status: 'starting', settings: DEFAULT_LOCK, biometry: null, message: null }));
  const set = (p: Partial<LockState>) => store.setState(p);
  let markReady: () => void = () => {};
  const ready = new Promise<void>(r => { markReady = r; });
  /** A system prompt is up: Android pauses and resumes the app around it, which must not count as leaving. */
  let prompting = false;
  let pausedAt: number | null = null;

  const open = (message: string | null = null) => { pausedAt = null; set({ status: 'open', message }); markReady(); };

  async function biometry(): Promise<Biometry> {
    try { return await deps.checkBiometry(); } catch { return NO_BIOMETRY; }
  }

  async function prompt(reason: string): Promise<void> {
    prompting = true;
    try { await deps.authenticate(reason); } finally { prompting = false; }
  }

  /** The device can no longer authenticate (passcode removed): the lock cannot work, so it is switched off. */
  async function turnOffForDevice(): Promise<void> {
    const settings = { ...store.getState().settings, enabled: false };
    set({ settings });
    await deps.saveSettings(settings).catch(() => {});
    await deps.setPrivacyScreen(false).catch(() => {});
    open('The app lock was turned off because this phone no longer has Face ID, a fingerprint or a passcode set up.');
  }

  async function unlock(): Promise<boolean> {
    const s = store.getState();
    if (s.status === 'open') return true;
    if (s.status === 'authenticating' || prompting) return false;
    set({ status: 'authenticating', message: null });
    try {
      await prompt('Unlock LotusPond Health to see your results.');
      open();
      return true;
    } catch (e) {
      const code = errorCode(e);
      if (NO_CREDENTIAL.has(code) && !canAuthenticate(await biometry())) { await turnOffForDevice(); return true; }
      set({
        status: 'locked',
        message: CANCELLED.has(code) ? null
          : code === 'authenticationFailed' ? 'Not recognised. Try again.'
          : code === 'biometryLockout' ? 'Too many attempts. Unlock your phone with its passcode, then try again.'
          : 'Could not unlock. Try again.',
      });
      return false;
    }
  }

  return {
    store,
    ready,

    async start() {
      const loaded = await deps.loadSettings().catch(() => 'unreadable' as const);
      // A settings file that exists but cannot be read keeps the lock on rather than silently dropping it.
      const settings: LockSettings = loaded === 'unreadable' ? { ...DEFAULT_LOCK, enabled: true } : loaded ?? DEFAULT_LOCK;
      const b = await biometry();
      set({ settings, biometry: b });
      if (!settings.enabled) { open(); return 'open'; }
      if (!canAuthenticate(b)) { await turnOffForDevice(); return 'open'; }
      await deps.setPrivacyScreen(true).catch(() => {});
      set({ status: 'locked' });
      return 'locked';
    },

    unlock,

    onPause() {
      const s = store.getState();
      if (prompting || !s.settings.enabled || s.status !== 'open') return;
      pausedAt = deps.now();
      if (s.settings.delayMs === 0) set({ status: 'locked', message: null });
    },

    onResume() {
      const s = store.getState();
      if (prompting || !s.settings.enabled) return;
      if (s.status === 'locked') { void unlock(); return; }
      if (s.status === 'open' && pausedAt !== null) {
        const away = deps.now() - pausedAt;
        pausedAt = null;
        if (away >= s.settings.delayMs) { set({ status: 'locked', message: null }); void unlock(); }
      }
    },

    async setEnabled(on) {
      const s = store.getState();
      if (s.settings.enabled === on) return true;
      const b = await biometry();
      set({ biometry: b });
      if (on && !canAuthenticate(b)) {
        set({ message: 'Set up Face ID, a fingerprint or a passcode in your phone’s settings first.' });
        return false;
      }
      try {
        await prompt(on ? 'Confirm to lock LotusPond Health.' : 'Confirm to turn off the app lock.');
      } catch (e) {
        set({ message: CANCELLED.has(errorCode(e)) ? null : 'Could not confirm it was you, so nothing was changed.' });
        return false;
      }
      const settings = { ...store.getState().settings, enabled: on };
      await deps.saveSettings(settings);
      await deps.setPrivacyScreen(on).catch(() => {});
      pausedAt = null;
      set({ settings, message: null });
      return true;
    },

    async setDelay(delayMs) {
      const settings = { ...store.getState().settings, delayMs };
      await deps.saveSettings(settings);
      set({ settings });
    },
  };
}
