// Group scan modalities and stored files into the families the icons draw.

export type Modality = 'xray' | 'ct' | 'mri' | 'us' | 'photo' | 'scan';

/** Group a DICOM modality code or label into an icon family. */
export function modalityFamily(modality?: string | null): Modality {
  const m = (modality ?? '').toUpperCase();
  if (/^(CR|DX|XR|RG|MG|X-?RAY)/.test(m)) return 'xray';
  if (/^CT/.test(m)) return 'ct';
  if (/^(MR|MRI)/.test(m)) return 'mri';
  if (/^(US|ULTRA)/.test(m)) return 'us';
  if (/^(PHOTO|XC|OT|IMAGE)/.test(m)) return 'photo';
  return 'scan';
}

export const MODALITY_LABEL: Record<Modality, string> = { xray: 'X-ray', ct: 'CT', mri: 'MRI', us: 'Ultrasound', photo: 'Photo', scan: 'Scan' };

/** Plain name for a modality, e.g. "X-ray" for "CR" or "DX". */
export function modalityLabel(modality?: string | null): string {
  const fam = modalityFamily(modality);
  return fam === 'scan' && modality ? modality : MODALITY_LABEL[fam];
}

export type FileFamily = 'pdf' | 'table' | 'code' | 'dicom' | 'image' | 'file';

export function fileFamily(fileName: string, contentType: string): FileFamily {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (contentType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/csv|tab-separated/.test(contentType) || ext === 'csv' || ext === 'tsv') return 'table';
  if (/json/.test(contentType) || ext === 'json') return 'code';
  if (/dicom/.test(contentType) || ext === 'dcm') return 'dicom';
  if (contentType.startsWith('image/')) return 'image';
  return 'file';
}

export const FILE_LABEL: Record<FileFamily, string> = { pdf: 'PDF', table: 'CSV', code: 'JSON', dicom: 'DICOM', image: 'Image', file: 'File' };
