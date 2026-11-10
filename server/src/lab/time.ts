// India Standard Time helpers. IST is UTC+05:30 all year (no daylight saving), so a fixed offset is exact.
const IST_OFFSET_MS = 330 * 60_000;

/** yyyy-mm-dd in IST. */
export const istDate = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** ISO 8601 with the IST offset, e.g. 2026-11-03T08:12:00+05:30. */
export const istIso = (ms: number): string => `${new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;
