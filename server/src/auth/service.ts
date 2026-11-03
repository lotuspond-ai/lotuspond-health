// Phone OTP sign-in and sessions (design doc §7). Partners need a verified phone number anyway, so it doubles
// as the account. Codes: 6 digits, valid 5 minutes, 5 tries, stored only as an HMAC under a server secret.
// Sends per number: at least 30 s apart and at most 5 an hour (the HTTP layer also limits per address).
// Sessions: a random bearer token, stored only as its SHA-256, valid 30 days.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { newId } from '../crypto/keys.ts';
import type { Logger } from '../log.ts';
import type { AccountStore } from '../store/types.ts';

export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

/** Development only: prints the code. Production sends a DLT-registered SMS template through a provider. */
export function printingOtpSender(print: (line: string) => void): OtpSender {
  return { async send(phone, code) { print(`OTP for ${phone.slice(0, 3)}******${phone.slice(-4)}: ${code}`); } };
}

export type AuthErrorCode = 'invalid_phone' | 'too_soon' | 'too_many_codes' | 'invalid_code' | 'code_expired' | 'too_many_attempts';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly retryAfterMs: number | null;

  constructor(code: AuthErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface AuthOptions {
  /** Secret for hashing codes. 32 random bytes from the secrets manager. */
  otpPepper: Uint8Array;
  otpTtlMs?: number;
  maxAttempts?: number;
  resendAfterMs?: number;
  maxSendsPerHour?: number;
  sessionTtlMs?: number;
}

export interface AuthDeps {
  accounts: AccountStore;
  sender: OtpSender;
  now: () => number;
  log: Logger;
}

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** Indian mobile numbers in E.164; the partners we book with only take these. */
export const PHONE_RE = /^\+91[6-9]\d{9}$/;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class AuthService {
  private readonly deps: AuthDeps;
  private readonly pepper: Buffer;
  private readonly otpTtlMs: number;
  private readonly maxAttempts: number;
  private readonly resendAfterMs: number;
  private readonly maxSendsPerHour: number;
  private readonly sessionTtlMs: number;

  constructor(deps: AuthDeps, opts: AuthOptions) {
    if (opts.otpPepper.length < 32) throw new Error('otpPepper must be at least 32 bytes');
    this.deps = deps;
    this.pepper = Buffer.from(opts.otpPepper);
    this.otpTtlMs = opts.otpTtlMs ?? 5 * MIN;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.resendAfterMs = opts.resendAfterMs ?? 30_000;
    this.maxSendsPerHour = opts.maxSendsPerHour ?? 5;
    this.sessionTtlMs = opts.sessionTtlMs ?? 30 * DAY;
  }

  async requestOtp(phone: string): Promise<{ expiresAt: number; resendAt: number }> {
    if (!PHONE_RE.test(phone)) throw new AuthError('invalid_phone', 'Use an Indian mobile number in the form +91XXXXXXXXXX');
    const { accounts, sender, now: clock, log } = this.deps;
    const now = clock();
    const sends = await accounts.otpSendsSince(phone, now - HOUR);
    const last = sends.length ? Math.max(...sends) : null;
    if (last != null && now - last < this.resendAfterMs) throw new AuthError('too_soon', 'Wait before asking for another code', last + this.resendAfterMs - now);
    if (sends.length >= this.maxSendsPerHour) throw new AuthError('too_many_codes', 'Too many codes for this number; try again later', Math.min(...sends) + HOUR - now);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await accounts.putOtp({ phone, codeHash: this.codeHash(phone, code), createdAt: now, expiresAt: now + this.otpTtlMs, attempts: 0, consumedAt: null });
    await sender.send(phone, code);
    log.info('otp sent');
    return { expiresAt: now + this.otpTtlMs, resendAt: now + this.resendAfterMs };
  }

  async verifyOtp(phone: string, code: string): Promise<{ token: string; expiresAt: number; userId: string; newUser: boolean }> {
    const { accounts, now: clock, log } = this.deps;
    const now = clock();
    const c = await accounts.getOtp(phone);
    if (!c || c.consumedAt != null) throw new AuthError('invalid_code', 'That code is not valid; ask for a new one');
    if (now > c.expiresAt) throw new AuthError('code_expired', 'That code has expired; ask for a new one');
    // Count the attempt first and judge the limit on the counted value, so parallel guesses can't exceed it.
    const counted = await accounts.updateOtp(phone, x => ({ ...x, attempts: x.attempts + 1 }));
    if (!counted || counted.attempts > this.maxAttempts) throw new AuthError('too_many_attempts', 'Too many wrong codes; ask for a new one');
    const given = /^\d{6}$/.test(code) ? this.codeHash(phone, code) : '';
    if (!given || !timingSafeEqual(Buffer.from(given), Buffer.from(c.codeHash))) {
      const left = this.maxAttempts - counted.attempts;
      throw new AuthError(left > 0 ? 'invalid_code' : 'too_many_attempts', left > 0 ? `Wrong code; ${left} ${left === 1 ? 'try' : 'tries'} left` : 'Too many wrong codes; ask for a new one');
    }
    // Check-and-set, so the same code can't be used twice in parallel.
    let won = false;
    await accounts.updateOtp(phone, x => {
      if (x.consumedAt != null || x.codeHash !== c.codeHash) return x;
      won = true;
      return { ...x, consumedAt: now };
    });
    if (!won) throw new AuthError('invalid_code', 'That code is not valid; ask for a new one');

    const existing = await accounts.findUserByPhone(phone);
    const user = existing ?? await accounts.createUser({ id: newId('usr'), phone, createdAt: now, deletedAt: null });
    const token = `lps_${randomBytes(32).toString('base64url')}`;
    const expiresAt = now + this.sessionTtlMs;
    await accounts.createSession({ tokenHash: sha256(token), userId: user.id, createdAt: now, expiresAt, lastUsedAt: now, revokedAt: null });
    log.info('signed in', { userId: user.id, newUser: !existing });
    return { token, expiresAt, userId: user.id, newUser: !existing };
  }

  /** The signed-in user for a bearer token, or null. */
  async authenticate(token: string): Promise<{ userId: string } | null> {
    if (!token.startsWith('lps_')) return null;
    const { accounts, now: clock } = this.deps;
    const now = clock();
    const hash = sha256(token);
    const s = await accounts.getSession(hash);
    if (!s || s.revokedAt != null || now >= s.expiresAt) return null;
    const user = await accounts.getUser(s.userId);
    if (!user || user.deletedAt != null) return null;
    // Avoid a write per request: note use at most once an hour.
    if (now - s.lastUsedAt > HOUR) await accounts.updateSession(hash, x => ({ ...x, lastUsedAt: now }));
    return { userId: s.userId };
  }

  async logout(token: string): Promise<void> {
    await this.deps.accounts.updateSession(sha256(token), s => ({ ...s, revokedAt: s.revokedAt ?? this.deps.now() }));
  }

  private codeHash(phone: string, code: string): string {
    return createHmac('sha256', this.pepper).update(`${phone}|${code}`).digest('hex');
  }
}
