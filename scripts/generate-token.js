#!/usr/bin/env node
import crypto from 'node:crypto';

const password = process.argv[2] || 'admin123';
const salt = crypto.randomBytes(16).toString('base64url');
const iterations = 120000;
const keyLength = 32;

crypto.pbkdf2(password, salt, iterations, keyLength, 'sha256', (err, derivedKey) => {
  if (err) throw err;
  const hash = derivedKey.toString('base64url');
  const token = `pbkdf2.sha256.${iterations}.${salt}.${hash}`;
  console.log(`\nPassword: "${password}"`);
  console.log(`Generated Token:\n${token}\n`);
  console.log(`Add to your .env:`);
  console.log(`DAO_CANON_GATE_TOKEN=${token}\n`);
});
