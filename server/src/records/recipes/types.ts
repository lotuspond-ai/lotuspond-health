// What a recipe (the steps for one portal) or the navigator gets to work with, and what it hands back.
import type { BrowserContext, Page } from 'playwright-core';
import type { RecordQuestionKind, SourceInfo } from '../../../../shared/sources.ts';

/** A report found on a portal. `key` is the portal's own id for it (or a hash), to tell new reports from old ones. */
export interface PortalReport {
  key: string;
  title: string;
  /** yyyy-mm-dd, when the portal shows one. */
  date: string | null;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface Ask {
  kind: RecordQuestionKind;
  label: string;
  hint?: string;
  /** Hide what is typed (passwords). Codes are shown, so the person can check them. */
  secret?: boolean;
}

export interface RecipeContext {
  page: Page;
  context: BrowserContext;
  source: SourceInfo;
  /** Where to start: the source's address, or the portal address the person gave. */
  startUrl: string;
  allowHosts: string[];
  /** The phone number or user name the person gave last time, if any. */
  identifier: string | null;
  /** Ask the person and wait for the answer. In a scheduled run there is nobody to ask: it throws NeedsPersonError. */
  ask(q: Ask): Promise<string>;
  /** Keep the phone number or user name for next time (sealed; shown masked). */
  remember(identifier: string): void;
  /** Tell the person what is happening ("Signing in", "Downloading 3 reports"). */
  step(text: string): Promise<void>;
  /** Download a file the portal links to, in this browser's session; refuses hosts outside allowHosts. */
  download(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  signal: AbortSignal;
  /** Largest file accepted. */
  maxBytes: number;
}

export interface Recipe {
  sourceId: string;
  run(ctx: RecipeContext): Promise<PortalReport[]>;
}

/** The portal wants the person (a code, a password) and nobody is there: a scheduled run. */
export class NeedsPersonError extends Error {}

/** Something the person should read: the portal refused the code, there is no account for that number, … */
export class PortalError extends Error {}

/** The person cancelled the run, or did not answer in time. */
export class RunStoppedError extends Error {}

/** Types the record agent saves; anything else a portal offers is skipped. */
export const REPORT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'application/fhir+json': 'json', 'application/json': 'json',
};

/** The type from the bytes when the portal's header is vague (application/octet-stream). */
export function sniffType(bytes: Uint8Array, declared: string): string {
  const d = declared.split(';')[0].trim().toLowerCase();
  if (REPORT_TYPES[d]) return d;
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return d;
}
