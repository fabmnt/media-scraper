import { eq } from 'drizzle-orm';
import {
  credentialSessionExpiredMessage,
  type Platform,
} from '@media-scraper/shared';
import { platformCredentialStates } from './schema.js';
import type { Database } from './index.js';

export async function markCredentialSessionValid(
  db: Database,
  platform: Platform,
) {
  const now = new Date();
  await db
    .insert(platformCredentialStates)
    .values({ platform, status: 'valid', message: null, detectedAt: now })
    .onConflictDoUpdate({
      target: platformCredentialStates.platform,
      set: { status: 'valid', message: null, detectedAt: now, updatedAt: now },
    });
}

export async function markCredentialSessionExpired(
  db: Database,
  platform: Platform,
) {
  const now = new Date();
  const message = credentialSessionExpiredMessage(platform);
  await db
    .insert(platformCredentialStates)
    .values({ platform, status: 'expired', message, detectedAt: now })
    .onConflictDoUpdate({
      target: platformCredentialStates.platform,
      set: { status: 'expired', message, detectedAt: now, updatedAt: now },
    });
  return message;
}

export async function resetCredentialSession(db: Database, platform: Platform) {
  await db
    .delete(platformCredentialStates)
    .where(eq(platformCredentialStates.platform, platform));
}
