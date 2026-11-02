// Export all data as JSON (re-importable via parseFile).
import type { Measurement, ScanItem } from '../types';

export interface ExportData {
  version: 1;
  exportedAt: string;
  app: 'LotusPond Health';
  measurements: Measurement[];
  /** Scan metadata including the small thumbnail; original files are not included. */
  scans: ScanItem[];
}

export function buildExport(state: { measurements: Measurement[]; scans: ScanItem[] }): ExportData {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    app: 'LotusPond Health',
    measurements: state.measurements,
    scans: state.scans,
  };
}

/** JSON Blob of the user's data. */
export function exportJSON(state: { measurements: Measurement[]; scans: ScanItem[] }): Blob {
  return new Blob([JSON.stringify(buildExport(state), null, 2)], { type: 'application/json' });
}

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Export and download in one step, e.g. "lotuspond-health-2026-11-02.json". */
export function downloadExport(state: { measurements: Measurement[]; scans: ScanItem[] }): void {
  downloadBlob(exportJSON(state), `lotuspond-health-${new Date().toISOString().slice(0, 10)}.json`);
}
