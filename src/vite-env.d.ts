/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_MODEL_PATH?: string;
  /** 'browser' builds a server-less preview that keeps accounts and records in the browser. */
  readonly VITE_BACKEND?: 'browser' | 'server';
  /** API origin for the iOS / Android apps (default: the public site), e.g. http://192.168.1.20:8787 when testing. */
  readonly VITE_API_ORIGIN?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
