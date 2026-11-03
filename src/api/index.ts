// Picks where records are kept. Preview builds (VITE_BACKEND=browser) keep everything in this browser.
import type { Backend } from './backend';
import { BrowserBackend } from './browser';
import { HttpBackend } from './http';

export const backend: Backend = import.meta.env.VITE_BACKEND === 'browser' ? new BrowserBackend() : new HttpBackend();
export const isPreview = backend.kind === 'browser';
export { ApiError, errorMessage } from './backend';
export type { Backend } from './backend';
