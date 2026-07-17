import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { INSTAGRAM_CREDENTIAL_FILE_NAME } from '@media-scraper/shared';

const INSTAGRAM_DOMAIN = 'instagram.com';
const SESSION_COOKIE_NAME = 'sessionid';
const NETSCAPE_HEADER = [
  '# Netscape HTTP Cookie File',
  '# Stored locally by Media Scraper. Do not share this file.',
].join('\n');
const HTTP_ONLY_PREFIX = '#HttpOnly_';
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

class InvalidInstagramCredentialError extends Error {
  readonly statusCode = 400;
}

function isInstagramDomain(domain: string) {
  const normalizedDomain = domain
    .replace(HTTP_ONLY_PREFIX, '')
    .replace(/^\./, '');
  return (
    normalizedDomain === INSTAGRAM_DOMAIN ||
    normalizedDomain.endsWith(`.${INSTAGRAM_DOMAIN}`)
  );
}

function normalizeNetscapeCookies(content: string): string | undefined {
  const records = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        (!line.startsWith('#') || line.startsWith(HTTP_ONLY_PREFIX)),
    )
    .filter((line) => {
      const [domain] = line.split('\t');
      return domain ? isInstagramDomain(domain) : false;
    });
  const validRecords = records.filter((line) => line.split('\t').length >= 7);
  const hasSession = validRecords.some(
    (line) => line.split('\t')[5] === SESSION_COOKIE_NAME,
  );

  return hasSession
    ? `${NETSCAPE_HEADER}\n${validRecords.join('\n')}\n`
    : undefined;
}

function normalizeCookieHeader(content: string): string | undefined {
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
  if (!cookies.some(({ name }) => name === SESSION_COOKIE_NAME))
    return undefined;

  const records = cookies.map(
    ({ name, value }) => `.instagram.com\tTRUE\t/\tTRUE\t0\t${name}\t${value}`,
  );
  return `${NETSCAPE_HEADER}\n${records.join('\n')}\n`;
}

export function normalizeInstagramCookies(content: string) {
  const normalized = content.includes('\t')
    ? normalizeNetscapeCookies(content)
    : normalizeCookieHeader(content);
  if (!normalized) {
    throw new InvalidInstagramCredentialError(
      'Cookies must be a Netscape cookies.txt file or Cookie header containing an Instagram sessionid',
    );
  }
  return normalized;
}

export function instagramCredentialPath(credentialsRoot: string) {
  return join(credentialsRoot, INSTAGRAM_CREDENTIAL_FILE_NAME);
}

export async function hasInstagramCredential(credentialsRoot: string) {
  try {
    await access(instagramCredentialPath(credentialsRoot));
    return true;
  } catch {
    return false;
  }
}

export async function saveInstagramCredential(
  credentialsRoot: string,
  cookies: string,
) {
  const path = instagramCredentialPath(credentialsRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, normalizeInstagramCookies(cookies), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function deleteInstagramCredential(credentialsRoot: string) {
  await rm(instagramCredentialPath(credentialsRoot), { force: true });
}
