'use strict';

const argon2 = require('argon2');

// OWASP Password Storage Cheat Sheet: Argon2id, m=19 MiB, t=2, p=1 (minimum);
// we use 64 MiB / t=3 which is ~60 ms on modern servers.
const OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };
const TEST_OPTIONS = { type: argon2.argon2id, memoryCost: 8192, timeCost: 2, parallelism: 1 };
const opts = () => (process.env.NODE_ENV === 'test' ? TEST_OPTIONS : OPTIONS);

const hashPassword = (plain) => argon2.hash(plain, opts());

let dummyHash;
async function verifyPassword(hash, plain) {
  if (!hash) {
    // Equalise timing for unknown accounts to limit user enumeration.
    dummyHash = dummyHash || (await argon2.hash('dummy-password-for-timing', opts()));
    await argon2.verify(dummyHash, String(plain || '')).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, String(plain || ''));
  } catch {
    return false;
  }
}

const needsRehash = (hash) => argon2.needsRehash(hash, opts());

module.exports = { hashPassword, verifyPassword, needsRehash };
