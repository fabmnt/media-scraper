import type {
  Collection,
  CredentialStatus,
  CreateCollectionInput,
  MediaItem,
  Platform,
} from '@media-scraper/shared';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      body?.message ?? `Request failed with status ${response.status}`,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

export const api = {
  getInstagramCredential: () =>
    request<CredentialStatus>('/credentials/instagram'),
  saveInstagramCredential: (cookies: string) =>
    request<CredentialStatus>('/credentials/instagram', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookies }),
    }),
  deleteInstagramCredential: () =>
    request<void>('/credentials/instagram', { method: 'DELETE' }),
  createCollection: (input: CreateCollectionInput) =>
    request<Collection>('/collections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  listCollections: () => request<Collection[]>('/collections'),
  retryCollection: (id: string) =>
    request<Collection>(`/collections/${id}/retry`, { method: 'POST' }),
  listMedia: (filters: {
    platform?: Platform | undefined;
    search?: string | undefined;
  }) => {
    const params = new URLSearchParams();
    if (filters.platform) params.set('platform', filters.platform);
    if (filters.search) params.set('search', filters.search);
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return request<MediaItem[]>(`/media-items${query}`);
  },
  deleteMedia: (id: string) =>
    request<void>(`/media-items/${id}`, { method: 'DELETE' }),
  mediaUrl: (path: string) =>
    path.startsWith('http') ? path : `${API_URL}${path}`,
};
