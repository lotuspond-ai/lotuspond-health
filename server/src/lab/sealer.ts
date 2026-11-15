// Encryption at rest for lab data we keep: patients' contact details on orders, and raw partner webhook bodies
// (they may carry results). It uses the cell's file keyring and main's file format (lib/files-encrypted.ts), so lab
// data follows the same keys, rotation and FILE_ENCRYPTION setting as stored files. The context (e.g. the order id)
// is bound into the authenticated data, so a sealed value can't be moved to another order or webhook.
import type { FileKeyring } from '../compliance/secrets.ts';
import { decryptFile, encryptFile, isEncrypted } from '../lib/files-encrypted.ts';

export interface Sealer {
  seal(plain: Uint8Array, context: string): Uint8Array;
  /** Throws if the data was altered, sealed for another context, or with a key this server doesn't have. */
  open(sealed: Uint8Array, context: string): Uint8Array;
}

/** Seal with a keyring; with none (FILE_ENCRYPTION=off, development only) data is kept as is. */
export function keyringSealer(ring: FileKeyring | null | undefined): Sealer {
  return {
    seal(plain, context) {
      return ring ? new Uint8Array(encryptFile(`lab:${context}`, plain, ring.current)) : plain.slice();
    },
    open(sealed, context) {
      if (ring) return new Uint8Array(decryptFile(`lab:${context}`, sealed, ring));
      if (isEncrypted(sealed)) throw new Error('This lab data is encrypted, but file encryption is off');
      return sealed.slice();
    },
  };
}
