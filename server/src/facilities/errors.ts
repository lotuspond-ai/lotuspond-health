// Errors from the facility providers. Routes turn them into a 503 the interface can explain.

/** An outside service (Overpass, Nominatim) failed, timed out or answered with something unusable. */
export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

export type FacilityErrorCode = 'search_unavailable' | 'search_off' | 'busy';

export const FACILITY_MESSAGES: Record<FacilityErrorCode, string> = {
  search_unavailable: 'Nearby search is unavailable right now. Try again in a few minutes.',
  search_off: 'Nearby search is turned off on this server.',
  busy: 'Nearby search is busy. Try again in a few seconds.',
};

export class FacilityError extends Error {
  readonly code: FacilityErrorCode;
  constructor(code: FacilityErrorCode) {
    super(FACILITY_MESSAGES[code]);
    this.code = code;
    this.name = 'FacilityError';
  }
}
