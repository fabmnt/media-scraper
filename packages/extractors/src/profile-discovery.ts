import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  MAX_PROFILE_MEDIA,
  profileMediaSchema,
  type Platform,
  type ProfileLookup,
  type ProfileMedia,
  type ProfileMediaResults,
} from '@media-scraper/shared';
import { z } from 'zod';
import {
  decodeProfileCursor,
  encodeProfileCursor,
  InvalidProfileCursorError,
  type ProfileSourceCursor,
} from './profile-pagination.js';
import { YT_DLP_IMPERSONATION_TARGET } from './yt-dlp.js';

const execFileAsync = promisify(execFile);
const DISCOVERY_TIMEOUT_MS = 90_000;
const PROFILE_RESOLUTION_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_DISCOVERY_PROCESSES = 1;
const MAX_DISCOVERY_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PROFILE_PAGE_BYTES = 2 * 1024 * 1024;
const INSTAGRAM_PROFILE_ID_PATTERNS = [
  /"profile_id":"(\d+)"/,
  /"page_id":"profilePage_(\d+)"/,
  /"id":"(\d+)","show_suggested_profiles"/,
] as const;
const GALLERY_DIRECTORY_MESSAGE = 2;
const GALLERY_URL_MESSAGE = 3;
const GALLERY_ERROR_MESSAGE = -1;
const INSTAGRAM_STORIES_SPLIT_OPTION = 'extractor.instagram.stories.split=true';
const INSTAGRAM_HIGHLIGHTS_PATH = 'highlights';
const TIKTOK_POST_PATH_PATTERN = /\/(?:video|photo)\/\d+(?:[/?#]|$)/;
// gallery-dl retrieves Highlight reels in batches of five; fetch one batch per lookup.
const MAX_HIGHLIGHTS_PER_DISCOVERY_PAGE = 4;

const optionalString = z.string().optional().catch(undefined);
const optionalIdentifier = z
  .union([z.string(), z.number().transform(String)])
  .optional()
  .catch(undefined);
const optionalPositiveInteger = z
  .number()
  .int()
  .positive()
  .optional()
  .catch(undefined);
const imageSchema = z.looseObject({
  imageURL: z
    .looseObject({ urlList: z.array(z.string()).catch([]) })
    .optional()
    .catch(undefined),
});
const galleryMetadataSchema = z.looseObject({
  caption: optionalString,
  count: optionalPositiveInteger,
  date: optionalString,
  desc: optionalString,
  description: optionalString,
  display_url: optionalString,
  fullname: optionalString,
  highlight_title: optionalString,
  id: optionalIdentifier,
  imagePost: z
    .looseObject({ images: z.array(imageSchema).catch([]) })
    .optional()
    .catch(undefined),
  media_id: optionalIdentifier,
  post_date: optionalString,
  post_id: optionalIdentifier,
  post_shortcode: optionalIdentifier,
  post_type: optionalString,
  post_url: optionalString,
  shortcode: optionalIdentifier,
  title: optionalString,
  type: optionalString,
  url: optionalString,
  user: optionalString,
  username: optionalString,
  video: z
    .looseObject({ cover: optionalString, dynamicCover: optionalString })
    .optional()
    .catch(undefined),
  video_url: optionalString,
});
const galleryMessageSchema = z.union([
  z.tuple([z.literal(GALLERY_DIRECTORY_MESSAGE), galleryMetadataSchema]),
  z.tuple([z.literal(GALLERY_URL_MESSAGE), z.string(), galleryMetadataSchema]),
  z.tuple([
    z.literal(GALLERY_ERROR_MESSAGE),
    z.looseObject({ message: z.string().catch('Profile extraction failed') }),
  ]),
]);
const galleryOutputSchema = z.array(galleryMessageSchema);
const ytDlpProfileMetadataSchema = z.looseObject({
  description: optionalString,
  id: optionalIdentifier,
  original_url: optionalString,
  thumbnail: optionalString,
  timestamp: z.number().finite().optional().catch(undefined),
  title: optionalString,
  uploader: optionalString,
  url: optionalString,
  webpage_url: optionalString,
});
type GalleryMessage = z.infer<typeof galleryMessageSchema>;
type GalleryMetadata = z.infer<typeof galleryMetadataSchema>;

let activeDiscoveryProcesses = 0;
const discoveryQueue: Array<() => void> = [];

async function acquireDiscoverySlot(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
  if (activeDiscoveryProcesses < MAX_CONCURRENT_DISCOVERY_PROCESSES) {
    activeDiscoveryProcesses += 1;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener('abort', cancel);
      activeDiscoveryProcesses += 1;
      resolve();
    };
    const cancel = () => {
      const queueIndex = discoveryQueue.indexOf(start);
      if (queueIndex >= 0) discoveryQueue.splice(queueIndex, 1);
      reject(signal?.reason);
    };
    discoveryQueue.push(start);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function releaseDiscoverySlot() {
  activeDiscoveryProcesses -= 1;
  discoveryQueue.shift()?.();
}

async function instagramProfileId(username: string, signal?: AbortSignal) {
  const response = await fetch(
    `https://www.instagram.com/${encodeURIComponent(username)}/`,
    {
      headers: { 'user-agent': 'media-scraper/0.1' },
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(PROFILE_RESOLUTION_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(PROFILE_RESOLUTION_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Instagram profile returned HTTP ${String(response.status)}`,
    );
  }

  if (!response.body) throw new Error('Instagram profile returned no content');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_PROFILE_PAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Instagram profile page exceeded the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const html = Buffer.concat(chunks, receivedBytes).toString('utf8');
  for (const pattern of INSTAGRAM_PROFILE_ID_PATTERNS) {
    const profileId = pattern.exec(html)?.[1];
    if (profileId) return profileId;
  }
  throw new Error('Instagram profile ID was not found');
}

type ProfileSourceKind = 'posts' | 'reels' | 'stories' | 'highlights';

interface ProfileSource {
  kind: ProfileSourceKind;
  options?: string[];
  url: string;
  include: (metadata: GalleryMetadata) => boolean;
}

interface ProfileDiscoveryOptions {
  includeStories?: boolean;
  onStoryError?: (error: Error) => void;
}

function profileSourceCount(
  platform: Platform,
  includeStories: boolean,
  includeHighlights: boolean,
) {
  const baseSourceCount = platform === 'instagram' ? 2 : 1;
  const supportsStories = platform === 'instagram' || platform === 'tiktok';
  const supportsHighlights = platform === 'instagram';
  return (
    baseSourceCount +
    Number(includeStories && supportsStories) +
    Number(includeHighlights && supportsHighlights)
  );
}

async function profileSources(
  platform: Platform,
  username: string,
  profileIdentifier: string | undefined,
  includeStories: boolean,
  includeHighlights: boolean,
  signal?: AbortSignal,
): Promise<{
  profileIdentifier: string | undefined;
  sources: ProfileSource[];
}> {
  const encodedUsername = encodeURIComponent(username);
  switch (platform) {
    case 'instagram': {
      const identifier =
        profileIdentifier ??
        (await instagramProfileId(username, signal)
          .then((profileId) => `id:${profileId}`)
          .catch(() => encodedUsername));
      return {
        profileIdentifier: identifier.startsWith('id:')
          ? identifier
          : undefined,
        sources: [
          {
            kind: 'posts',
            url: `https://www.instagram.com/${identifier}/posts/`,
            include: (metadata) =>
              metadata.type !== 'reel' &&
              !metadata.post_url?.includes('/reel/'),
          },
          {
            kind: 'reels',
            url: `https://www.instagram.com/${identifier}/reels/`,
            include: () => true,
          },
          ...(includeStories
            ? [
                {
                  kind: 'stories' as const,
                  options: [INSTAGRAM_STORIES_SPLIT_OPTION],
                  url: `https://www.instagram.com/stories/${identifier}/`,
                  include: () => true,
                },
              ]
            : []),
          ...(includeHighlights
            ? [
                {
                  kind: 'highlights' as const,
                  url: `https://www.instagram.com/${identifier}/${INSTAGRAM_HIGHLIGHTS_PATH}/`,
                  include: () => true,
                },
              ]
            : []),
        ],
      };
    }
    case 'facebook':
      return {
        profileIdentifier: undefined,
        sources: [
          {
            kind: 'posts',
            url: `https://www.facebook.com/${encodedUsername}/photos`,
            include: () => true,
          },
        ],
      };
    case 'tiktok':
      return {
        profileIdentifier: undefined,
        sources: [
          {
            kind: 'posts',
            url: `https://www.tiktok.com/@${encodedUsername}`,
            include: () => true,
          },
          ...(includeStories
            ? [
                {
                  kind: 'stories' as const,
                  url: `https://www.tiktok.com/@${encodedUsername}/stories`,
                  include: () => true,
                },
              ]
            : []),
        ],
      };
  }
}

function publishedDate(metadata: GalleryMetadata) {
  const value = metadata.post_date ?? metadata.date;
  if (!value) return null;

  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const date = new Date(withTimezone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sourceDetails(
  platform: Platform,
  username: string,
  source: ProfileSource,
  metadata: GalleryMetadata,
) {
  switch (platform) {
    case 'instagram': {
      if (source.kind === 'stories') {
        const id = metadata.media_id;
        return id
          ? {
              id,
              sourceUrl: `https://www.instagram.com/stories/${encodeURIComponent(metadata.username ?? username)}/${id}/`,
            }
          : undefined;
      }
      if (source.kind === 'highlights') {
        const id = metadata.post_id ?? metadata.id;
        return id
          ? {
              id,
              sourceUrl:
                metadata.post_url ??
                `https://www.instagram.com/stories/${INSTAGRAM_HIGHLIGHTS_PATH}/${id}/`,
            }
          : undefined;
      }

      const id =
        metadata.post_shortcode ??
        metadata.shortcode ??
        metadata.post_id ??
        metadata.id;
      return id
        ? {
            id,
            sourceUrl:
              metadata.post_url ?? `https://www.instagram.com/p/${id}/`,
          }
        : undefined;
    }
    case 'facebook': {
      const id = metadata.id ?? metadata.post_id;
      return id
        ? {
            id,
            sourceUrl: `https://www.facebook.com/photo/?fbid=${id}`,
          }
        : undefined;
    }
    case 'tiktok': {
      const id = metadata.id ?? metadata.post_id;
      const route = metadata.post_type === 'image' ? 'photo' : 'video';
      return id
        ? {
            id,
            sourceUrl: `https://www.tiktok.com/@${encodeURIComponent(username)}/${route}/${id}`,
          }
        : undefined;
    }
  }
}

function thumbnailUrl(platform: Platform, metadata: GalleryMetadata) {
  switch (platform) {
    case 'instagram':
      return metadata.display_url ?? null;
    case 'facebook':
      return metadata.url ?? null;
    case 'tiktok':
      return (
        metadata.video?.cover ??
        metadata.video?.dynamicCover ??
        metadata.imagePost?.images[0]?.imageURL?.urlList[0] ??
        null
      );
  }
}

function mediaType(platform: Platform, metadata: GalleryMetadata) {
  if (platform === 'tiktok') {
    return metadata.post_type === 'image'
      ? ('image' as const)
      : ('video' as const);
  }
  return metadata.type === 'video' ||
    metadata.type === 'reel' ||
    metadata.video_url
    ? ('video' as const)
    : ('image' as const);
}

function assetCount(platform: Platform, metadata: GalleryMetadata) {
  if (platform === 'tiktok' && metadata.imagePost?.images.length) {
    return metadata.imagePost.images.length;
  }
  return metadata.count ?? 1;
}

function sourcePageSize(source: ProfileSource, pageSize: number) {
  return source.kind === 'highlights'
    ? Math.min(pageSize, MAX_HIGHLIGHTS_PER_DISCOVERY_PAGE)
    : pageSize;
}

function tikTokProfileMessages(
  output: string,
  username: string,
): GalleryMessage[] {
  return output.split('\n').flatMap((line) => {
    if (!line) return [];

    try {
      const entry = ytDlpProfileMetadataSchema.parse(JSON.parse(line));
      if (!entry.id) return [];

      const postUrl = [entry.webpage_url, entry.original_url, entry.url].find(
        (url) => url && TIKTOK_POST_PATH_PATTERN.test(url),
      );
      const isPhoto = postUrl?.includes('/photo/');
      const publishedAt = entry.timestamp
        ? new Date(entry.timestamp * 1_000).toISOString()
        : undefined;
      return [
        [
          GALLERY_DIRECTORY_MESSAGE,
          {
            description: entry.description ?? entry.title,
            id: entry.id,
            post_type: isPhoto ? 'image' : undefined,
            post_url:
              postUrl ??
              `https://www.tiktok.com/@${encodeURIComponent(username)}/${isPhoto ? 'photo' : 'video'}/${entry.id}`,
            username: entry.uploader ?? username,
            video: entry.thumbnail ? { cover: entry.thumbnail } : undefined,
            ...(publishedAt ? { date: publishedAt } : {}),
          },
        ],
      ] as GalleryMessage[];
    } catch {
      return [];
    }
  });
}

async function extractProfileSource(
  platform: Platform,
  username: string,
  source: ProfileSource,
  offset: number,
  pageSize: number,
  authenticationArguments: string[],
  signal?: AbortSignal,
) {
  const fetchSize = pageSize + 1;
  if (offset > Number.MAX_SAFE_INTEGER - fetchSize) {
    throw new InvalidProfileCursorError(
      'The profile continuation cursor is invalid.',
    );
  }
  const rangeStart = offset + 1;
  const rangeEnd = offset + fetchSize;
  const postRange =
    platform === 'tiktok'
      ? `1-${String(fetchSize)}`
      : `${String(rangeStart)}-${String(rangeEnd)}`;
  const maxPosts = platform === 'tiktok' ? fetchSize : rangeEnd;

  let stdout: string;
  await acquireDiscoverySlot(signal);
  try {
    const result = await execFileAsync(
      platform === 'tiktok' ? 'yt-dlp' : 'gallery-dl',
      platform === 'tiktok'
        ? [
            '--flat-playlist',
            '--playlist-start',
            String(rangeStart),
            '--playlist-end',
            String(rangeEnd),
            '--dump-json',
            '--impersonate',
            YT_DLP_IMPERSONATION_TARGET,
            ...authenticationArguments,
            source.url,
          ]
        : [
            '--config-ignore',
            '--no-input',
            '--dump-json',
            '--post-range',
            postRange,
            '--option',
            `max-posts=${String(maxPosts)}`,
            '--option',
            `tiktok-range=${String(rangeStart)}-${String(rangeEnd)}`,
            ...(source.options?.flatMap((option) => ['--option', option]) ??
              []),
            ...authenticationArguments,
            source.url,
          ],
      {
        encoding: 'utf8',
        maxBuffer: MAX_DISCOVERY_OUTPUT_BYTES,
        signal,
        timeout: DISCOVERY_TIMEOUT_MS,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    throw new Error(
      'Could not read this profile. Check the username and platform authentication.',
      { cause: error },
    );
  } finally {
    releaseDiscoverySlot();
  }

  if (platform === 'tiktok') return tikTokProfileMessages(stdout, username);

  try {
    return galleryOutputSchema.parse(JSON.parse(stdout));
  } catch (error) {
    throw new Error('The profile extractor returned invalid metadata.', {
      cause: error,
    });
  }
}

function profileMedia(
  platform: Platform,
  username: string,
  source: ProfileSource,
  metadata: GalleryMetadata,
) {
  const details = sourceDetails(platform, username, source, metadata);
  if (!details || !source.include(metadata)) return undefined;

  const candidate = profileMediaSchema.safeParse({
    ...details,
    platform,
    sourceKind: source.kind,
    sourceVersion:
      source.kind === 'highlights' ? String(metadata.count ?? 0) : null,
    thumbnailUrl: thumbnailUrl(platform, metadata),
    caption:
      metadata.description ??
      metadata.desc ??
      metadata.caption ??
      metadata.highlight_title ??
      metadata.title ??
      null,
    publishedAt: publishedDate(metadata),
    type: mediaType(platform, metadata),
    assetCount: assetCount(platform, metadata),
  });
  return candidate.success ? candidate.data : undefined;
}

function normalizeSourcePage(
  messages: z.infer<typeof galleryOutputSchema>,
  source: ProfileSource,
  platform: Platform,
  username: string,
) {
  const entries: Array<ProfileMedia | undefined> = [];
  const highlightMediaIds = new Map<ProfileMedia, string[]>();
  const mediaByUrl = new Map<string, ProfileMedia>();
  let currentEntryIndex: number | undefined;
  let currentMedia: ProfileMedia | undefined;

  for (const message of messages) {
    if (message[0] === GALLERY_ERROR_MESSAGE) continue;

    if (message[0] === GALLERY_DIRECTORY_MESSAGE) {
      const metadata = message[1];
      currentEntryIndex = entries.push(undefined) - 1;
      const candidate = profileMedia(platform, username, source, metadata);
      if (!candidate) {
        currentMedia = undefined;
        continue;
      }

      currentMedia = mediaByUrl.get(candidate.sourceUrl) ?? candidate;
      mediaByUrl.set(currentMedia.sourceUrl, currentMedia);
      if (
        source.kind === 'highlights' &&
        !highlightMediaIds.has(currentMedia)
      ) {
        highlightMediaIds.set(currentMedia, []);
      }
      entries[currentEntryIndex] = currentMedia;
      continue;
    }

    const [, directUrl, metadata] = message;
    if (
      !currentMedia &&
      source.kind === 'stories' &&
      platform === 'instagram' &&
      currentEntryIndex !== undefined
    ) {
      const candidate = profileMedia(platform, username, source, metadata);
      if (candidate) {
        currentMedia = mediaByUrl.get(candidate.sourceUrl) ?? candidate;
        mediaByUrl.set(currentMedia.sourceUrl, currentMedia);
        entries[currentEntryIndex] = currentMedia;
      }
    }
    if (!currentMedia) continue;

    if (source.kind === 'highlights' && metadata.media_id) {
      highlightMediaIds.get(currentMedia)?.push(metadata.media_id);
    }
    if (!currentMedia.thumbnailUrl) {
      const candidateThumbnail =
        thumbnailUrl(platform, metadata) ??
        (metadata.type === 'image' ? directUrl : null);
      const parsedThumbnail = z.url().safeParse(candidateThumbnail);
      if (parsedThumbnail.success) {
        currentMedia.thumbnailUrl = parsedThumbnail.data;
      }
    }
    if (metadata.video_url || metadata.type === 'video') {
      currentMedia.type = 'video';
    }
  }

  for (const [media, mediaIds] of highlightMediaIds) {
    if (mediaIds.length > 0) {
      media.sourceVersion = createHash('sha256')
        .update(JSON.stringify([...new Set(mediaIds)].sort()))
        .digest('base64url');
    }
  }
  return entries;
}

export async function discoverProfileMedia(
  { platform, username, cursor, includeHighlights }: ProfileLookup,
  cookiesPath?: string,
  signal?: AbortSignal,
  pageSize: number = MAX_PROFILE_MEDIA,
  { includeStories = false, onStoryError }: ProfileDiscoveryOptions = {},
): Promise<ProfileMediaResults> {
  const sourceCount = profileSourceCount(
    platform,
    includeStories,
    includeHighlights,
  );
  const cursorContext = {
    includeHighlights,
    includeStories,
    platform,
    username,
    sourceCount,
  };
  const continuation = decodeProfileCursor(cursor, cursorContext);
  const profile = await profileSources(
    platform,
    username,
    continuation.profileIdentifier,
    includeStories,
    includeHighlights,
    signal,
  );
  const authenticationArguments = cookiesPath ? ['--cookies', cookiesPath] : [];
  const sourceResults = await Promise.all(
    profile.sources.map(async (source, index) => {
      const sourceCursor = continuation.sources[index]!;
      if (sourceCursor.completed) {
        return { completed: true, entries: [], errors: [] };
      }

      try {
        const messages = await extractProfileSource(
          platform,
          username,
          source,
          sourceCursor.offset,
          sourcePageSize(source, pageSize),
          authenticationArguments,
          signal,
        );
        const errors = messages.flatMap((message) =>
          message[0] === GALLERY_ERROR_MESSAGE
            ? [new Error(message[1].message)]
            : [],
        );
        return {
          completed: source.kind === 'stories' && errors.length > 0,
          entries: normalizeSourcePage(messages, source, platform, username),
          errors,
        };
      } catch (error) {
        return {
          completed: source.kind === 'stories',
          entries: [],
          errors: [
            error instanceof Error
              ? error
              : new Error('Profile extraction failed'),
          ],
        };
      }
    }),
  );
  const sourcePages = sourceResults.map((result) => result.entries);
  const sourcePageSizes = profile.sources.map((source) =>
    sourcePageSize(source, pageSize),
  );
  let extractionError: Error | undefined;
  for (const [index, result] of sourceResults.entries()) {
    const source = profile.sources[index]!;
    for (const error of result.errors) {
      if (source.kind === 'stories') {
        onStoryError?.(error);
      } else {
        extractionError ??= error;
      }
    }
  }
  if (extractionError) throw extractionError;

  const sourcePageKeys = sourcePages.map((entries) =>
    entries.map((entry) =>
      entry
        ? createHash('sha256').update(entry.sourceUrl).digest('base64url')
        : undefined,
    ),
  );
  const candidates = new Map<string, ProfileMedia>();
  for (const [index, entries] of sourcePages.entries()) {
    const skippedKeys = new Set(continuation.sources[index]?.skipKeys ?? []);
    for (const [entryIndex, media] of entries.entries()) {
      const key = sourcePageKeys[index]?.[entryIndex];
      if (media && key && !skippedKeys.has(key)) {
        candidates.set(media.sourceUrl, media);
      }
    }
  }
  const items = [...candidates.values()]
    .sort((left, right) =>
      (right.publishedAt ?? '').localeCompare(left.publishedAt ?? ''),
    )
    .slice(0, pageSize);

  const selectedUrls = new Set(items.map((item) => item.sourceUrl));
  let hasContinuation = false;
  const nextSources = sourcePages.map((entries, index): ProfileSourceCursor => {
    const current = continuation.sources[index]!;
    const result = sourceResults[index]!;
    if (result.completed) {
      return { ...current, completed: true, skipKeys: [] };
    }

    const entryKeys = sourcePageKeys[index] ?? [];
    const emittedKeys = new Set(current.skipKeys);
    for (const [entryIndex, entry] of entries.entries()) {
      const key = entryKeys[entryIndex];
      if (entry && key && selectedUrls.has(entry.sourceUrl)) {
        emittedKeys.add(key);
      }
    }

    let consumedEntries = 0;
    for (const key of entryKeys) {
      if (key && !emittedKeys.has(key)) break;
      consumedEntries += 1;
    }
    const remainingKeys = new Set(
      entryKeys.slice(consumedEntries).filter((key) => key !== undefined),
    );
    const skipKeys = [...emittedKeys].filter((key) => remainingKeys.has(key));
    if (
      consumedEntries < entries.length ||
      entries.length === (sourcePageSizes[index] ?? pageSize) + 1
    ) {
      hasContinuation = true;
    }
    return {
      completed: false,
      offset: current.offset + consumedEntries,
      skipKeys,
    };
  });

  return {
    items,
    nextCursor: hasContinuation
      ? encodeProfileCursor(
          cursorContext,
          nextSources,
          profile.profileIdentifier,
        )
      : null,
  };
}
