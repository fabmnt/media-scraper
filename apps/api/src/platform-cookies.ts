import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PLATFORM_CREDENTIALS, type Platform } from '@media-scraper/shared';

const NETSCAPE_HEADER = [
  '# Netscape HTTP Cookie File',
  '# Stored locally by Media Scraper. Do not share this file.',
].join('\n');
const HTTP_ONLY_PREFIX = '#HttpOnly_';
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

class InvalidPlatformCredentialError extends Error {
  readonly statusCode = 400;
}

function isPlatformDomain(domain: string, platformDomain: string) {
  const normalizedDomain = domain
    .replace(HTTP_ONLY_PREFIX, '')
    .replace(/^\./, '')
    .toLowerCase();
  return (
    normalizedDomain === platformDomain ||
    normalizedDomain.endsWith(`.${platformDomain}`)
  );
}

function hasRequiredCookies(records: readonly string[], platform: Platform) {
  const cookieNames = new Set(records.map((line) => line.split('\t')[5]));
  return PLATFORM_CREDENTIALS[platform].requiredCookies.every((cookieName) =>
    cookieNames.has(cookieName),
  );
}

function normalizeNetscapeCookies(
  content: string,
  platform: Platform,
): string | undefined {
  const { domain } = PLATFORM_CREDENTIALS[platform];
  const records = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        (!line.startsWith('#') || line.startsWith(HTTP_ONLY_PREFIX)),
    )
    .filter((line) => {
      const fields = line.split('\t');
      return (
        fields.length >= 7 &&
        Boolean(fields[0] && isPlatformDomain(fields[0], domain))
      );
    });

  return hasRequiredCookies(records, platform)
    ? `${NETSCAPE_HEADER}\n${records.join('\n')}\n`
    : undefined;
}

function normalizeCookieHeader(
  content: string,
  platform: Platform,
): string | undefined {
  const header = content.replace(/^cookie\s*:\s*/i, '').trim();
  if (header.includes('\n') || header.includes('\r') || header.includes('\t')) {
    return undefined;
  }

  const cookies = header.split(';').flatMap((segment) => {
    const separatorIndex = segment.indexOf('=');
    if (separatorIndex <= 0) return [];

    const name = segment.slice(0, separatorIndex).trim();
    const value = segment.slice(separatorIndex + 1).trim();
    return COOKIE_NAME_PATTERN.test(name) && value ? [{ name, value }] : [];
  });
  const { domain, requiredCookies } = PLATFORM_CREDENTIALS[platform];
  const cookieNames = new Set(cookies.map(({ name }) => name));
  if (!requiredCookies.every((cookieName) => cookieNames.has(cookieName))) {
    return undefined;
  }

  const records = cookies.map(
    ({ name, value }) => `.${domain}\tTRUE\t/\tTRUE\t0\t${name}\t${value}`,
  );
  return `${NETSCAPE_HEADER}\n${records.join('\n')}\n`;
}

export function normalizePlatformCookies(content: string, platform: Platform) {
  const normalized = content.includes('\t')
    ? normalizeNetscapeCookies(content, platform)
    : normalizeCookieHeader(content, platform);
  if (!normalized) {
    const requiredCookieNames =
      PLATFORM_CREDENTIALS[platform].requiredCookies.join(' and ');
    throw new InvalidPlatformCredentialError(
      `Cookies must be a Netscape cookies.txt file or Cookie header for ${PLATFORM_CREDENTIALS[platform].domain} containing ${requiredCookieNames}`,
    );
  }
  return normalized;
}

export function platformCredentialPath(
  credentialsRoot: string,
  platform: Platform,
) {
  return join(credentialsRoot, PLATFORM_CREDENTIALS[platform].fileName);
}

export async function hasPlatformCredential(
  credentialsRoot: string,
  platform: Platform,
) {
  try {
    await access(platformCredentialPath(credentialsRoot, platform));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function savePlatformCredential(
  credentialsRoot: string,
  platform: Platform,
  cookies: string,
) {
  const path = platformCredentialPath(credentialsRoot, platform);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      normalizePlatformCookies(cookies, platform),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function deletePlatformCredential(
  credentialsRoot: string,
  platform: Platform,
) {
  await rm(platformCredentialPath(credentialsRoot, platform), { force: true });
}
