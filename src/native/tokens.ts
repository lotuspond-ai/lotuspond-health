// The apps' session token, kept in the iOS Keychain / Android Keystore-encrypted storage, never in web storage.
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { StoredSession, TokenStore } from '../api/appSession';

const KEY = 'session';
let configured: Promise<void> | null = null;

function configure(): Promise<void> {
  // This device only, readable only while it is unlocked, and not synced through iCloud Keychain.
  configured ??= Promise.all([
    SecureStorage.setKeyPrefix('lotuspond_'),
    SecureStorage.setSynchronize(false),
    SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly),
  ]).then(() => {});
  return configured;
}

export const nativeTokens: TokenStore = {
  async load() {
    await configure();
    const v = await SecureStorage.get(KEY);
    if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return null;
    const s = v as Partial<StoredSession>;
    return typeof s.token === 'string' && typeof s.origin === 'string' ? { token: s.token, origin: s.origin, expiresAt: typeof s.expiresAt === 'string' ? s.expiresAt : undefined } : null;
  },
  async save(session) {
    await configure();
    if (session) await SecureStorage.set(KEY, { ...session });
    else await SecureStorage.remove(KEY);
  },
};
