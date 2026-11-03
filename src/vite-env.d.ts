/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_MODEL_PATH?: string;
  /** 'browser' builds a server-less preview that keeps accounts and records in the browser. */
  readonly VITE_BACKEND?: 'browser' | 'server';
}
interface ImportMeta { readonly env: ImportMetaEnv }
