import { randomUUID } from 'node:crypto';
import { PLATFORM_CREDENTIALS, type Platform } from '@media-scraper/shared';
import {
  normalizePlatformCookies,
  savePlatformCredential,
} from './platform-cookies.js';

const LOGIN_SESSION_TTL_MS = 10 * 60 * 1_000;
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const BROWSER_CLOSE_TIMEOUT_MS = 3_000;
const HTTP_ONLY_PREFIX = '#HttpOnly_';

export interface BrowserLoginConfig {
  publicUrl: string;
  token?: string | undefined;
  url: string;
}

interface LoginSession {
  browserWSEndpoint: string;
  expiresAt: Date;
  id: string;
  liveUrl: string;
  platform: Platform;
}

interface CdpCookie {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  secure: boolean;
  value: string;
}

interface BrowserQlResponse {
  data?: {
    liveURL?: { liveURL?: string };
    reconnect?: { browserWSEndpoint?: string };
  };
  errors?: Array<{ message: string }>;
}

const loginSessions = new Map<string, LoginSession>();

function withToken(endpoint: string, token: string | undefined) {
  if (!token) return endpoint;
  const url = new URL(endpoint);
  if (!url.searchParams.has('token')) url.searchParams.set('token', token);
  return url.toString();
}

function cdpRequest<T>(
  wsEndpoint: string,
  method: string,
  { resolveOnClose = false, timeoutMs = CDP_COMMAND_TIMEOUT_MS } = {},
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsEndpoint);
    const commandId = 1;
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      callback();
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`The login browser did not respond`)));
    }, timeoutMs);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: commandId, method, params: {} }));
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let payload: {
        error?: { message: string };
        id?: number;
        result?: T;
      };
      try {
        payload = JSON.parse(event.data) as typeof payload;
      } catch {
        return;
      }
      if (payload.id !== commandId) return;
      settle(() => {
        if (payload.error) reject(new Error(payload.error.message));
        else resolve(payload.result);
      });
    });
    socket.addEventListener('error', () => {
      settle(() =>
        reject(new Error('Could not reach the login browser session')),
      );
    });
    socket.addEventListener('close', () => {
      if (resolveOnClose) settle(() => resolve(undefined));
      else settle(() => reject(new Error('The login browser session ended')));
    });
  });
}

function closeBrowser(browserWSEndpoint: string, token: string | undefined) {
  return cdpRequest(withToken(browserWSEndpoint, token), 'Browser.close', {
    resolveOnClose: true,
    timeoutMs: BROWSER_CLOSE_TIMEOUT_MS,
  }).catch(() => undefined);
}

function netscapeRecord(cookie: CdpCookie) {
  const domain = cookie.httpOnly
    ? `${HTTP_ONLY_PREFIX}${cookie.domain}`
    : cookie.domain;
  const includeSubdomains = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  const expires = cookie.expires > 0 ? String(Math.floor(cookie.expires)) : '0';
  return [
    domain,
    includeSubdomains,
    cookie.path,
    secure,
    expires,
    cookie.name,
    cookie.value,
  ].join('\t');
}

function dropSession(session: LoginSession, token: string | undefined) {
  loginSessions.delete(session.id);
  return closeBrowser(session.browserWSEndpoint, token);
}

export async function startLoginSession(
  config: BrowserLoginConfig,
  platform: Platform,
): Promise<LoginSession> {
  const now = Date.now();
  for (const session of loginSessions.values()) {
    if (
      session.platform === platform ||
      session.expiresAt.getTime() <= now
    ) {
      await dropSession(session, config.token);
    }
  }

  const endpoint = new URL('/browserql', config.url);
  if (config.token) endpoint.searchParams.set('token', config.token);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `
        mutation StartLoginSession($loginUrl: String!, $sessionTimeout: Int!) {
          goto(url: $loginUrl) { status }
          liveURL(timeout: $sessionTimeout, interactable: true) { liveURL }
          reconnect(timeout: $sessionTimeout) { browserWSEndpoint }
        }
      `,
      variables: {
        loginUrl: PLATFORM_CREDENTIALS[platform].loginUrl,
        sessionTimeout: LOGIN_SESSION_TTL_MS,
      },
    }),
    signal: AbortSignal.timeout(CDP_COMMAND_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `The login browser returned HTTP ${String(response.status)}`,
    );
  }
  const payload = (await response.json()) as BrowserQlResponse;
  const liveUrl = payload.data?.liveURL?.liveURL;
  const browserWSEndpoint = payload.data?.reconnect?.browserWSEndpoint;
  if (!liveUrl || !browserWSEndpoint) {
    throw new Error(
      payload.errors?.[0]?.message ??
        'The login browser could not start an interactive session',
    );
  }

  const publicLiveUrl = new URL(liveUrl, config.url);
  const publicBase = new URL(config.publicUrl);
  publicLiveUrl.protocol = publicBase.protocol;
  publicLiveUrl.host = publicBase.host;

  const session: LoginSession = {
    browserWSEndpoint,
    expiresAt: new Date(Date.now() + LOGIN_SESSION_TTL_MS),
    id: randomUUID(),
    liveUrl: withToken(publicLiveUrl.toString(), config.token),
    platform,
  };
  loginSessions.set(session.id, session);
  return session;
}

export async function pollLoginSession(
  config: BrowserLoginConfig,
  credentialsRoot: string,
  sessionId: string,
): Promise<{
  platform: Platform | undefined;
  status: 'completed' | 'expired' | 'pending';
}> {
  const session = loginSessions.get(sessionId);
  if (!session) {
    return { platform: undefined, status: 'expired' };
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    await dropSession(session, config.token);
    return { platform: session.platform, status: 'expired' };
  }

  let cookies: CdpCookie[];
  try {
    const result = await cdpRequest<{ cookies?: CdpCookie[] }>(
      withToken(session.browserWSEndpoint, config.token),
      'Storage.getCookies',
    );
    cookies = result?.cookies ?? [];
  } catch {
    await dropSession(session, config.token);
    return { platform: session.platform, status: 'expired' };
  }

  const { domain, requiredCookies } = PLATFORM_CREDENTIALS[session.platform];
  const platformCookies = cookies.filter(
    (cookie) =>
      cookie.domain === domain || cookie.domain.endsWith(`.${domain}`),
  );
  const cookieNames = new Set(platformCookies.map((cookie) => cookie.name));
  if (!requiredCookies.every((name) => cookieNames.has(name))) {
    return { platform: session.platform, status: 'pending' };
  }

  const normalized = normalizePlatformCookies(
    platformCookies.map(netscapeRecord).join('\n'),
    session.platform,
  );
  await savePlatformCredential(credentialsRoot, session.platform, normalized);
  await dropSession(session, config.token);
  return { platform: session.platform, status: 'completed' };
}

export async function cancelLoginSession(
  config: BrowserLoginConfig,
  sessionId: string,
) {
  const session = loginSessions.get(sessionId);
  if (session) await dropSession(session, config.token);
}
