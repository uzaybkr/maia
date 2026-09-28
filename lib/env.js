import os from 'node:os';
import path from 'node:path';

export const PORT = process.env.PORT || 3300;
export const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Kept outside the repo/OneDrive so user data and the photo key never sync to cloud storage.
export const DATA_DIR = process.env.MAIA_DATA_DIR || path.join(os.homedir(), '.maia');
// Photos get their own file, outside DATA_DIR in production, so backups/snapshots of DATA_DIR never contain a photo.
export const PHOTO_DB = process.env.MAIA_PHOTO_DB || path.join(DATA_DIR, 'photos.db');

// Production if declared OR if the app is served publicly over HTTPS, so a missing NODE_ENV can't
// silently re-enable dev conveniences (test upgrade, logged verify links, non-Secure cookies).
export const PROD = process.env.NODE_ENV === 'production' || APP_URL.startsWith('https://');

if (PROD) {
  const missing = ['MAIA_PHOTO_KEY', 'RESEND_API_KEY', 'MAIA_PHOTO_DB'].filter((k) => !process.env[k]);
  if (!APP_URL.startsWith('https://')) missing.push('APP_URL (https)');
  if (missing.length) throw new Error(`Refusing to start in production without: ${missing.join(', ')}`);
  if (path.resolve(PHOTO_DB).startsWith(path.resolve(DATA_DIR) + path.sep)) {
    throw new Error('MAIA_PHOTO_DB must live outside MAIA_DATA_DIR so photos never end up in backups');
  }
}
