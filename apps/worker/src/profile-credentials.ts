import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { PLATFORM_CREDENTIALS } from '@media-scraper/shared';

export async function profileCredentialPath(
  credentialsRoot: string,
  platform: keyof typeof PLATFORM_CREDENTIALS,
) {
  const path = join(credentialsRoot, PLATFORM_CREDENTIALS[platform].fileName);
  return access(path)
    .then(() => path)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
}
