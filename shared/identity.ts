// Sign-in through LotusPond Accounts (docs/identity.md): what the server and the sign-in page share.

/** Short messages for the sign-in page, by the code in `?accounts_error=`. */
export const ACCOUNTS_ERRORS = {
  cancelled: 'Sign-in with LotusPond Accounts was cancelled.',
  expired: 'That sign-in took too long or was started in another browser. Try again.',
  enterprise_account: 'This LotusPond account is managed by a company. LotusPond Health needs your personal account, so that no employer can manage the account that holds your health records.',
  email_unverified: 'Confirm your email address at LotusPond Accounts first, then sign in again.',
  already_linked: 'This LotusPond Health account is already linked to a different LotusPond account.',
  wrong_region: 'Your LotusPond account is held in a region this server does not serve.',
  sign_in_failed: 'LotusPond Accounts could not complete the sign-in. Try again.',
} as const satisfies Record<string, string>;

export type AccountsErrorCode = keyof typeof ACCOUNTS_ERRORS;

/** Where the website starts a sign-in through LotusPond Accounts. */
export const accountsStartPath = (intent: 'signup' | 'login') => `/api/auth/accounts/start?intent=${intent}`;
