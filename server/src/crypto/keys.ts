// Device public keys: the P-256 keys results are encrypted to (design doc §4.1). The browser sends one with
// each booking; we check it's a real public key on the curve and identify it by its RFC 7638 thumbprint.
import { createHash, createPublicKey, randomBytes } from 'node:crypto';

export interface DevicePublicJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string }

const B64URL = /^[A-Za-z0-9_-]+$/;

/** The normalised key, or an error message. A key carrying private material ("d") is refused outright. */
export function parseDeviceKey(v: unknown): DevicePublicJwk | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'devicePublicKey must be a JWK object';
  const k = v as Record<string, unknown>;
  if ('d' in k) return 'devicePublicKey contains a private key; send only the public key';
  if (k.kty !== 'EC' || k.crv !== 'P-256') return 'devicePublicKey must be an EC P-256 key';
  if (typeof k.x !== 'string' || typeof k.y !== 'string' || !B64URL.test(k.x) || !B64URL.test(k.y)) return 'devicePublicKey needs base64url x and y';
  const jwk: DevicePublicJwk = { kty: 'EC', crv: 'P-256', x: k.x, y: k.y };
  try {
    // Rejects points that aren't on the curve.
    createPublicKey({ key: { ...jwk }, format: 'jwk' });
  } catch {
    return 'devicePublicKey is not a valid P-256 public key';
  }
  return jwk;
}

/** RFC 7638: SHA-256 over the required members in lexicographic order, base64url. */
export function jwkThumbprint(k: DevicePublicJwk): string {
  const canonical = JSON.stringify({ crv: k.crv, kty: k.kty, x: k.x, y: k.y });
  return createHash('sha256').update(canonical).digest('base64url');
}

/** Random, unguessable ids: a prefix and 96 random bits in hex, e.g. ord_3f9c…. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}
