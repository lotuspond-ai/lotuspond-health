/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_MODEL_PATH?: string;
  /** 'browser' builds a server-less preview that keeps accounts and records in the browser. */
  readonly VITE_BACKEND?: 'browser' | 'server';
  /** API origin for the iOS / Android apps (default: the public site), e.g. http://192.168.1.20:8787 when testing. */
  readonly VITE_API_ORIGIN?: string;
  /** '1' in test builds of the apps: the sign-in screen can switch the API server (src/components/ServerPicker.tsx). */
  readonly VITE_SERVER_PICKER?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
