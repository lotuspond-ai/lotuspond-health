// Encrypts data we keep at rest with a server-held key: AES-256-GCM, a fresh 12-byte nonce per item.
// Used for raw webhook bodies (they may carry results). In production the key comes from the secrets
// manager or KMS (design doc §13); rotating it means adding a key id byte, which `version` leaves room for.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealer {
  seal(plain: Uint8Array): Uint8Array;
  /** Throws if the data was altered or sealed with another key. */
  open(sealed: Uint8Array): Uint8Array;
}

const VERSION = 1;
const IV_BYTES = 12, TAG_BYTES = 16;

/** Layout: version (1 byte) | nonce (12) | auth tag (16) | ciphertext. */
export function aesGcmSealer(key: Uint8Array): Sealer {
  if (key.length !== 32) throw new Error('Sealer key must be 32 bytes');
  const k = Buffer.from(key);
  return {
    seal(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', k, iv);
      const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
      return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]));
    },
    open(sealed) {
      const b = Buffer.from(sealed);
      if (b.length < 1 + IV_BYTES + TAG_BYTES || b[0] !== VERSION) throw new Error('Not a sealed item');
      const iv = b.subarray(1, 1 + IV_BYTES), tag = b.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', k, iv);
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(b.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]));
    },
  };
}
