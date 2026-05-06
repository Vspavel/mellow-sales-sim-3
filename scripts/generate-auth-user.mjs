#!/usr/bin/env node
// Usage:
//   node scripts/generate-auth-user.mjs <username> [password]
// If password is omitted, a strong random one is generated and printed.
// Output: a single AUTH_USERS-formatted entry, plus the plaintext password (only on stdout).

import crypto from 'crypto';
import { deriveSaltedHash } from '../middleware/auth.js';

const [, , usernameArg, passwordArg] = process.argv;

if (!usernameArg) {
  console.error('usage: node scripts/generate-auth-user.mjs <username> [password]');
  process.exit(2);
}

const username = String(usernameArg).trim().toLowerCase();
if (!username || username.includes(':') || username.includes(',')) {
  console.error("username must be non-empty and must not contain ':' or ','");
  process.exit(2);
}

let password = passwordArg;
let generated = false;
if (!password) {
  password = crypto.randomBytes(15).toString('base64url');
  generated = true;
}

const { hash, salt } = deriveSaltedHash(password);
const entry = `${username}:${hash}:${salt}`;

console.log('AUTH_USERS entry (append to env, comma-separated):');
console.log(entry);
console.log('');
console.log(`username: ${username}`);
console.log(`password: ${password}${generated ? '   (generated; share via secure channel)' : ''}`);
