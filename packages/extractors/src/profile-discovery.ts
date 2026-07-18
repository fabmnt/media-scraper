import { execFile } from 'node:child_process';
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

const execFileAsync = promisify(execFile);
const DISCOVERY_TIMEOUT_MS = 90_000;
const PROFILE_RESOLUTION_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_DISCOVERY_PROCESSES = 2;
const MAX_DISCOVERY_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PROFILE_PAGE_BYTES = 2 * 1024 * 1024;
const PROFILE_PAGE_FETCH_SIZE = MAX_PROFILE_MEDIA + 1;
const INSTAGRAM_PROFILE_ID_PATTERNS = [
  /"profile_id":"(\d+)"/,
  /"page_id":"profilePage_(\d+)"/,
  /"id":"(\d+)","show_suggested_profiles"/,
] as const;
const GALLERY_DIRECTORY_MESSAGE = 2;
const GALLERY_URL_MESSAGE = 3;
const GALLERY_ERROR_MESSAGE = -1;

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
  id: optionalIdentifier,
  imagePost: z
    .looseObject({ images: z.array(imageSchema).catch([]) })
    .optional()
    .catch(undefined),
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

interface ProfileSource {
  url: string;
  include: (metadata: GalleryMetadata) => boolean;
}

async function profileSources(
  platform: Platform,
  username: string,
  profileIdentifier: string | undefined,
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
            url: `https://www.instagram.com/${identifier}/posts/`,
            include: (metadata) =>
              metadata.type !== 'reel' &&
              !metadata.post_url?.includes('/reel/'),
          },
          {
            url: `https://www.instagram.com/${identifier}/reels/`,
            include: () => true,
          },
        ],
      };
    }
    case 'facebook':
      return {
        profileIdentifier: undefined,
        sources: [
          {
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
            url: `https://www.tiktok.com/@${encodedUsername}/posts`,
            include: () => true,
          },
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
  metadata: GalleryMetadata,
) {
  switch (platform) {
    case 'instagram': {
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
  return metadata.type === 'video' || metadata.type === 'reel'
    ? ('video' as const)
    : ('image' as const);
}

function assetCount(platform: Platform, metadata: GalleryMetadata) {
  if (platform === 'tiktok' && metadata.imagePost?.images.length) {
    return metadata.imagePost.images.length;
  }
  return metadata.count ?? 1;
}

async function extractProfileSource(
  platform: Platform,
  url: string,
  offset: number,
  authenticationArguments: string[],
  signal?: AbortSignal,
) {
  if (offset > Number.MAX_SAFE_INTEGER - PROFILE_PAGE_FETCH_SIZE) {
    throw new InvalidProfileCursorError(
      'The profile continuation cursor is invalid.',
    );
  }
  const rangeStart = offset + 1;
  const rangeEnd = offset + PROFILE_PAGE_FETCH_SIZE;
  const postRange =
    platform === 'tiktok'
      ? `1-${String(PROFILE_PAGE_FETCH_SIZE)}`
      : `${String(rangeStart)}-${String(rangeEnd)}`;
  const maxPosts = platform === 'tiktok' ? PROFILE_PAGE_FETCH_SIZE : rangeEnd;

  let stdout: string;
  await acquireDiscoverySlot(signal);
  try {
    const result = await execFileAsync(
      'gallery-dl',
      [
        '--config-ignore',
        '--no-input',
        '--dump-json',
        '--post-range',
        postRange,
        '--option',
        `max-posts=${String(maxPosts)}`,
        '--option',
        `tiktok-range=${String(rangeStart)}-${String(rangeEnd)}`,
        ...authenticationArguments,
        url,
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

  try {
    return galleryOutputSchema.parse(JSON.parse(stdout));
  } catch (error) {
    throw new Error('The profile extractor returned invalid metadata.', {
      cause: error,
    });
  }
}

function normalizeSourcePage(
  messages: z.infer<typeof galleryOutputSchema>,
  source: ProfileSource,
  platform: Platform,
  username: string,
) {
  const entries: Array<ProfileMedia | undefined> = [];
  const mediaByUrl = new Map<string, ProfileMedia>();
  let currentMedia: ProfileMedia | undefined;

  for (const message of messages) {
    if (message[0] === GALLERY_ERROR_MESSAGE) continue;

    if (message[0] === GALLERY_DIRECTORY_MESSAGE) {
      const metadata = message[1];
      const entryIndex = entries.push(undefined) - 1;
      const details = sourceDetails(platform, username, metadata);
      if (!details || !source.include(metadata)) {
        currentMedia = undefined;
        continue;
      }

      const candidate = profileMediaSchema.safeParse({
        ...details,
        platform,
        thumbnailUrl: thumbnailUrl(platform, metadata),
        caption:
          metadata.description ??
          metadata.desc ??
          metadata.caption ??
          metadata.title ??
          null,
        publishedAt: publishedDate(metadata),
        type: mediaType(platform, metadata),
        assetCount: assetCount(platform, metadata),
      });
      if (!candidate.success) {
        currentMedia = undefined;
        continue;
      }

      currentMedia = mediaByUrl.get(candidate.data.sourceUrl) ?? candidate.data;
      mediaByUrl.set(currentMedia.sourceUrl, currentMedia);
      entries[entryIndex] = currentMedia;
      continue;
    }

    if (!currentMedia) continue;
    const [, directUrl, metadata] = message;
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

  return entries;
}

export async function discoverProfileMedia(
  { platform, username, cursor }: ProfileLookup,
  cookiesPath?: string,
  signal?: AbortSignal,
): Promise<ProfileMediaResults> {
  const sourceCount = platform === 'instagram' ? 2 : 1;
  const cursorContext = { platform, username, sourceCount };
  const continuation = decodeProfileCursor(cursor, cursorContext);
  const profile = await profileSources(
    platform,
    username,
    continuation.profileIdentifier,
    signal,
  );
  const authenticationArguments = cookiesPath ? ['--cookies', cookiesPath] : [];
  const sourceResults = await Promise.all(
    profile.sources.map(async (source, index) => {
      try {
        const messages = await extractProfileSource(
          platform,
          source.url,
          continuation.sources[index]?.offset ?? 0,
          authenticationArguments,
          signal,
        );
        return {
          entries: normalizeSourcePage(messages, source, platform, username),
          errors: messages.flatMap((message) =>
            message[0] === GALLERY_ERROR_MESSAGE
              ? [new Error(message[1].message)]
              : [],
          ),
        };
      } catch (error) {
        return {
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
  const extractionError = sourceResults.flatMap((result) => result.errors)[0];
  if (extractionError) throw extractionError;

  const candidates = new Map<string, ProfileMedia>();
  for (const [index, entries] of sourcePages.entries()) {
    const skippedUrls = new Set(continuation.sources[index]?.skipUrls ?? []);
    for (const media of entries) {
      if (media && !skippedUrls.has(media.sourceUrl)) {
        candidates.set(media.sourceUrl, media);
      }
    }
  }
  const items = [...candidates.values()]
    .sort((left, right) =>
      (right.publishedAt ?? '').localeCompare(left.publishedAt ?? ''),
    )
    .slice(0, MAX_PROFILE_MEDIA);

  const selectedUrls = new Set(items.map((item) => item.sourceUrl));
  let hasContinuation = false;
  const nextSources = sourcePages.map((entries, index): ProfileSourceCursor => {
    const current = continuation.sources[index] ?? {
      offset: 0,
      skipUrls: [],
    };
    const emittedUrls = new Set(current.skipUrls);
    for (const entry of entries) {
      if (entry && selectedUrls.has(entry.sourceUrl)) {
        emittedUrls.add(entry.sourceUrl);
      }
    }

    let consumedEntries = 0;
    for (const entry of entries) {
      if (entry && !emittedUrls.has(entry.sourceUrl)) break;
      consumedEntries += 1;
    }
    const remainingUrls = new Set(
      entries
        .slice(consumedEntries)
        .flatMap((entry) => (entry ? [entry.sourceUrl] : [])),
    );
    const skipUrls = [...emittedUrls].filter((url) => remainingUrls.has(url));
    if (
      consumedEntries < entries.length ||
      entries.length === PROFILE_PAGE_FETCH_SIZE
    ) {
      hasContinuation = true;
    }
    return {
      offset: current.offset + consumedEntries,
      skipUrls,
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
