// Password hashing with Argon2id (OWASP recommended parameters: 19 MiB memory, 2 iterations).
import { hash, verify } from '@node-rs/argon2';

const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;

/** Spend the same time as a real check when the account does not exist, so timing does not reveal which emails are registered. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword('lotuspond-timing-equaliser');
  await verifyPassword(await dummy, password);
  return false;
}
