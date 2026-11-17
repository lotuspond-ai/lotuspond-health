// The hospital system adapters this server runs, by connector id (shared/integrations.ts). Only integrations whose
// status is available or on_request have an adapter; the rest are listed in the catalogue and refused when called.
import { INTEGRATIONS } from '../../../../shared/integrations.ts';
import { fhirAdapter } from './fhir.ts';
import { sandboxAdapter } from './sandbox.ts';
import type { HisAdapter } from './types.ts';

export const HIS_ADAPTERS: ReadonlyMap<string, HisAdapter> = new Map<string, HisAdapter>([
  ['sandbox', sandboxAdapter],
  ['fhir', fhirAdapter('fhir')],
  ['bahmni', fhirAdapter('bahmni')],
  ['trakcare', fhirAdapter('trakcare')],
]);

/** Integrations that can run here: every one with an adapter, and no adapter without a catalogue entry. */
export function runnableIntegrations() {
  return INTEGRATIONS.filter(i => HIS_ADAPTERS.has(i.id));
}

export { HisError } from './types.ts';
export type { HisAdapter, HisContext, HisSecret } from './types.ts';
