import { randomUUID } from 'node:crypto';
import { WebSocket as StreamClientSocket } from 'ws';
import {
  loginStreamClientMessageSchema,
  PLATFORM_CREDENTIALS,
  type Platform,
} from '@media-scraper/shared';
import {
  normalizePlatformCookies,
  savePlatformCredential,
} from './platform-cookies.js';

const LOGIN_SESSION_TTL_MS = 10 * 60 * 1_000;
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const BROWSER_CLOSE_TIMEOUT_MS = 3_000;
const SCREENCAST_JPEG_QUALITY = 70;
const HTTP_ONLY_PREFIX = '#HttpOnly_';

export interface BrowserLoginConfig {
  token?: string | undefined;
  url: string;
}

interface LoginSession {
  expiresAt: Date;
  id: string;
  pageWSEndpoint: string;
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

interface CdpConnection {
  close: () => void;
  onClose: (listener: () => void) => void;
  onEvent: (listener: (method: string, params: unknown) => void) => void;
  send: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

interface JsonNewTarget {
  id: string;
  webSocketDebuggerUrl: string;
}

interface ScreencastFrameParams {
  data: string;
  metadata: {
    deviceHeight: number;
    deviceWidth: number;
    offsetTop: number;
    pageScaleFactor: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
  };
  sessionId: number;
}

const loginSessions = new Map<string, LoginSession>();

function withToken(endpoint: string, token: string | undefined) {
  if (!token) return endpoint;
  const url = new URL(endpoint);
  if (!url.searchParams.has('token')) url.searchParams.set('token', token);
  return url.toString();
}

// The browserless container reports websocket URLs with its own bind address
// (e.g. ws://0.0.0.0:3000/), so the origin must be rewritten against the
// configured base URL the API can actually reach.
function rewriteEndpointOrigin(endpoint: string, config: BrowserLoginConfig) {
  const base = new URL(config.url);
  const url = new URL(endpoint);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  url.host = base.host;
  return url.toString();
}

function connectCdp(wsEndpoint: string): Promise<CdpConnection> {
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = new WebSocket(wsEndpoint);
    let nextCommandId = 0;
    const pending = new Map<
      number,
      { reject: (error: Error) => void; resolve: (result: never) => void }
    >();
    const listeners: Array<(method: string, params: unknown) => void> = [];
    const closeListeners: Array<() => void> = [];
    const connection: CdpConnection = {
      close: () => socket.close(),
      onClose: (listener) => closeListeners.push(listener),
      onEvent: (listener) => listeners.push(listener),
      send: (method, params = {}) =>
        new Promise((resolve, reject) => {
          if (socket.readyState !== WebSocket.OPEN) {
            reject(new Error('The login browser connection is not open'));
            return;
          }
          nextCommandId += 1;
          const timeout = setTimeout(() => {
            pending.delete(nextCommandId);
            reject(new Error('The login browser did not respond'));
          }, CDP_COMMAND_TIMEOUT_MS);
          pending.set(nextCommandId, {
            reject: (error) => {
              clearTimeout(timeout);
              reject(error);
            },
            resolve: (result) => {
              clearTimeout(timeout);
              resolve(result);
            },
          });
          socket.send(JSON.stringify({ id: nextCommandId, method, params }));
        }),
    };

    socket.addEventListener('open', () => resolveConnection(connection));
    socket.addEventListener('error', () => {
      rejectConnection(new Error('Could not reach the login browser session'));
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message: {
        error?: { message: string };
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
      };
      try {
        message = JSON.parse(event.data) as typeof message;
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const command = pending.get(message.id);
        if (!command) return;
        pending.delete(message.id);
        if (message.error) command.reject(new Error(message.error.message));
        else command.resolve(message.result as never);
        return;
      }
      if (message.method) {
        for (const listener of listeners) {
          listener(message.method, message.params);
        }
      }
    });
    socket.addEventListener('close', () => {
      for (const command of pending.values()) {
        command.reject(new Error('The login browser session ended'));
      }
      pending.clear();
      for (const listener of closeListeners) listener();
    });
  });
}

async function withPageConnection<T>(
  session: LoginSession,
  config: BrowserLoginConfig,
  run: (connection: CdpConnection) => Promise<T>,
  { closeTimeoutMs = CDP_COMMAND_TIMEOUT_MS } = {},
): Promise<T> {
  const connection = await Promise.race([
    connectCdp(withToken(session.pageWSEndpoint, config.token)),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error('The login browser did not respond')),
        closeTimeoutMs,
      );
    }),
  ]);
  try {
    return await run(connection);
  } finally {
    connection.close();
  }
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

async function closeSessionTarget(
  session: LoginSession,
  config: BrowserLoginConfig,
) {
  await withPageConnection(
    session,
    config,
    (connection) => connection.send('Page.close'),
    { closeTimeoutMs: BROWSER_CLOSE_TIMEOUT_MS },
  ).catch(() => undefined);
}

async function dropSession(session: LoginSession, config: BrowserLoginConfig) {
  loginSessions.delete(session.id);
  await closeSessionTarget(session, config);
}

export async function startLoginSession(
  config: BrowserLoginConfig,
  platform: Platform,
): Promise<LoginSession> {
  const now = Date.now();
  for (const session of loginSessions.values()) {
    if (session.platform === platform || session.expiresAt.getTime() <= now) {
      await dropSession(session, config);
    }
  }

  const endpoint = new URL('/json/new', config.url);
  if (config.token) endpoint.searchParams.set('token', config.token);
  const response = await fetch(endpoint, {
    method: 'PUT',
    signal: AbortSignal.timeout(CDP_COMMAND_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `The login browser returned HTTP ${String(response.status)}`,
    );
  }
  const target = (await response.json()) as Partial<JsonNewTarget>;
  if (!target.webSocketDebuggerUrl) {
    throw new Error('The login browser could not start an interactive page');
  }

  const session: LoginSession = {
    expiresAt: new Date(now + LOGIN_SESSION_TTL_MS),
    id: randomUUID(),
    pageWSEndpoint: rewriteEndpointOrigin(target.webSocketDebuggerUrl, config),
    platform,
  };
  try {
    await withPageConnection(session, config, async (connection) => {
      await connection.send('Page.enable');
      await connection.send('Page.navigate', {
        url: PLATFORM_CREDENTIALS[platform].loginUrl,
      });
    });
  } catch (error) {
    await closeSessionTarget(session, config);
    throw error instanceof Error
      ? error
      : new Error('The login browser could not open the sign-in page');
  }

  loginSessions.set(session.id, session);
  return session;
}

export function getActiveLoginSession(
  config: BrowserLoginConfig,
  sessionId: string,
) {
  const session = loginSessions.get(sessionId);
  if (!session) return undefined;
  if (session.expiresAt.getTime() <= Date.now()) {
    void dropSession(session, config);
    return undefined;
  }
  return session;
}

export async function attachLoginSessionStream(
  config: BrowserLoginConfig,
  session: LoginSession,
  client: StreamClientSocket,
) {
  const connection = await connectCdp(
    withToken(session.pageWSEndpoint, config.token),
  );
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    clearTimeout(ttlTimer);
    void connection.send('Page.stopScreencast').catch(() => undefined);
    connection.close();
    if (client.readyState === StreamClientSocket.OPEN) client.close();
  };
  const ttlRemainingMs = Math.max(
    session.expiresAt.getTime() - Date.now(),
    1_000,
  );
  const ttlTimer = setTimeout(detach, ttlRemainingMs);
  ttlTimer.unref();

  connection.onClose(() => {
    if (client.readyState === StreamClientSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ended' }));
    }
    detach();
  });

  connection.onEvent((method, params) => {
    if (
      method !== 'Page.screencastFrame' ||
      client.readyState !== StreamClientSocket.OPEN
    ) {
      return;
    }
    const frame = params as ScreencastFrameParams;
    client.send(
      JSON.stringify({
        data: frame.data,
        metadata: frame.metadata,
        type: 'frame',
      }),
    );
    void connection
      .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
      .catch(() => undefined);
  });

  client.on('message', (raw: Buffer | string) => {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const parsed = loginStreamClientMessageSchema.safeParse(payload);
    if (!parsed.success) return;
    const message = parsed.data;

    switch (message.type) {
      case 'key':
        void connection
          .send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: message.key,
            code: message.code,
            windowsVirtualKeyCode: message.windowsVirtualKeyCode,
          })
          .then(() =>
            connection.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: message.key,
              code: message.code,
              windowsVirtualKeyCode: message.windowsVirtualKeyCode,
            }),
          )
          .catch(() => undefined);
        break;
      case 'insertText':
        void connection
          .send('Input.insertText', { text: message.text })
          .catch(() => undefined);
        break;
      case 'mouse':
        void connection
          .send('Input.dispatchMouseEvent', {
            type: message.mouseType,
            x: message.x,
            y: message.y,
            button: message.button,
            clickCount: message.clickCount,
          })
          .catch(() => undefined);
        break;
      case 'viewport':
        void connection
          .send('Emulation.setDeviceMetricsOverride', {
            width: message.width,
            height: message.height,
            deviceScaleFactor: message.deviceScaleFactor,
            mobile: message.mobile,
          })
          .catch(() => undefined);
        break;
      case 'wheel':
        void connection
          .send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: message.x,
            y: message.y,
            deltaX: message.deltaX,
            deltaY: message.deltaY,
          })
          .catch(() => undefined);
        break;
    }
  });
  client.on('close', detach);
  client.on('error', detach);

  try {
    await connection.send('Page.enable');
    await connection.send('Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_JPEG_QUALITY,
      everyNthFrame: 1,
    });
    if (client.readyState === StreamClientSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ready' }));
    }
  } catch (error) {
    detach();
    throw error;
  }
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
    await dropSession(session, config);
    return { platform: session.platform, status: 'expired' };
  }

  let cookies: CdpCookie[];
  try {
    cookies = await withPageConnection(session, config, async (connection) => {
      const result = await connection.send<{ cookies?: CdpCookie[] }>(
        'Network.getAllCookies',
      );
      return result.cookies ?? [];
    });
  } catch {
    await dropSession(session, config);
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
  await dropSession(session, config);
  return { platform: session.platform, status: 'completed' };
}

export async function cancelLoginSession(
  config: BrowserLoginConfig,
  sessionId: string,
) {
  const session = loginSessions.get(sessionId);
  if (session) await dropSession(session, config);
}
