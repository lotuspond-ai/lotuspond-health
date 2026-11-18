// The inputs of the organisation operations: one schema each, used by the REST API (/v1/operations/:id) and the
// organisation MCP server (/v1/mcp), so both accept exactly the same thing. Every call names the connection it runs on.
import { z } from 'zod';
import type { OperationId } from '../types.ts';

const connection = z.string().uuid().describe('The connection to run on (GET /v1/connections). Every organisation has a sandbox connection.');
const ref = (what: string) => z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, `Use the ${what} id the system returned.`);

/** Largest document, before base64: 5 MB. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'text/plain'] as const;

export const OPERATION_INPUT = {
  'patients.search': z.object({
    connection,
    identifier: z.string().trim().min(1).max(100).optional().describe('An identifier the hospital holds: its MRN or UHID, or an ABHA number. "system|value" narrows it to one identifier system.'),
    name: z.string().trim().min(2).max(100).optional().describe('Part of the patient\'s name.'),
    phone: z.string().trim().regex(/^\+?[0-9 -]{6,20}$/).optional().describe('Mobile number.'),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Date of birth, YYYY-MM-DD.'),
    limit: z.number().int().min(1).max(50).default(10),
  }).refine(v => v.identifier || v.name || v.phone, { message: 'Give an identifier, a name or a phone number.' }),
  'encounters.list': z.object({
    connection,
    patient: ref('patient').describe('The patient id from patients.search.'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  'documents.upload': z.object({
    connection,
    patient: ref('patient').describe('The patient id from patients.search.'),
    encounter: ref('encounter').optional().describe('The visit or admission it belongs to (encounters.list).'),
    title: z.string().trim().min(1).max(200).describe('What the document is, e.g. "Discharge summary".'),
    contentType: z.enum(DOCUMENT_TYPES),
    data: z.string().min(1).max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]+=*$/, 'Send the document as base64.').describe('The document, base64-encoded (up to 5 MB).'),
    author: z.string().trim().max(120).optional().describe('Who wrote it, e.g. the clinician\'s name. Shown to the approver.'),
  }),
  'claims.status': z.object({
    connection,
    claim: ref('claim').describe('The claim or pre-authorisation number from the insurer or TPA.'),
  }),
  'tasks.run': z.object({
    connection,
    instruction: z.string().trim().min(10).max(2000).describe('What the agent should do in the system\'s web app, in plain words, e.g. "Book Asha Raman (UHID UH1001) with Dr Rao on 21 Nov 2026 at 10:30". One task, with the patient identified.'),
    patient: ref('patient').optional().describe('The patient id from patients.search, when the task is about one patient. Shown to the approver.'),
    maxSteps: z.number().int().min(1).max(60).default(30).describe('Most model turns the agent may take before it stops.'),
  }),
} satisfies Partial<Record<OperationId, z.ZodType>>;

export type RunnableOperation = keyof typeof OPERATION_INPUT;
export type OperationInput<O extends RunnableOperation> = z.output<(typeof OPERATION_INPUT)[O]>;

export const isRunnable = (op: string): op is RunnableOperation => Object.hasOwn(OPERATION_INPUT, op);
