import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROD } from './env.js';

// AES-256-GCM for photos at rest. Production must supply MAIA_PHOTO_KEY (64 hex chars) from a secret manager.
function loadKey() {
  if (process.env.MAIA_PHOTO_KEY) return Buffer.from(process.env.MAIA_PHOTO_KEY, 'hex');
  if (PROD) throw new Error('MAIA_PHOTO_KEY is required in production');
  const keyFile = path.join(DATA_DIR, 'photo.key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}

const KEY = loadKey();
if (KEY.length !== 32) throw new Error('MAIA_PHOTO_KEY must be 32 bytes (64 hex chars)');

export function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function open(sealed) {
  const [v, iv, tag, data] = sealed.split(':');
  if (v !== 'v1') throw new Error('Unknown sealed format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
