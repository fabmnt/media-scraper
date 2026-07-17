import type {
  Collection,
  CollectionStatus,
  CredentialStatus,
  CreateCollectionInput,
  MediaItem,
  Page,
  Platform,
} from '@media-scraper/shared';

const API_URL = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new ApiError(
      body?.message ?? `Request failed with status ${response.status}`,
      response.status,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

function pageQuery(parameters: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return query.size > 0 ? `?${query.toString()}` : '';
}

export const api = {
  getSession: () => request<{ authenticated: true }>('/auth/session'),
  login: (token: string) =>
    request<{ authenticated: true }>('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  logout: () => request<void>('/auth/session', { method: 'DELETE' }),
  getCredential: (platform: Platform) =>
    request<CredentialStatus>(`/credentials/${platform}`),
  saveCredential: (platform: Platform, cookies: string) =>
    request<CredentialStatus>(`/credentials/${platform}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookies }),
    }),
  deleteCredential: (platform: Platform) =>
    request<void>(`/credentials/${platform}`, { method: 'DELETE' }),
  createCollection: (input: CreateCollectionInput) =>
    request<Collection>('/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  listCollections: ({
    limit,
    offset,
    status,
  }: {
    limit?: number;
    offset?: number;
    status?: CollectionStatus;
  }) =>
    request<Page<Collection>>(
      `/collections${pageQuery({ limit, offset, status })}`,
    ),
  retryCollection: (id: string) =>
    request<Collection>(`/collections/${id}/retry`, { method: 'POST' }),
  listMedia: (filters: {
    limit?: number;
    offset?: number;
    platform?: Platform | undefined;
    search?: string | undefined;
  }) =>
    request<Page<MediaItem>>(
      `/media-items${pageQuery({
        limit: filters.limit,
        offset: filters.offset,
        platform: filters.platform,
        search: filters.search,
      })}`,
    ),
  deleteMedia: (id: string) =>
    request<void>(`/media-items/${id}`, { method: 'DELETE' }),
  mediaUrl: (path: string) =>
    path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `${API_URL}${path}`,
  downloadUrl: (assetId: string) =>
    `${API_URL}/media-items/${assetId}/download`,
};
