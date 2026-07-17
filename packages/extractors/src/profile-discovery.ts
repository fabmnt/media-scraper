import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MAX_PROFILE_MEDIA,
  profileMediaSchema,
  type Platform,
  type ProfileLookup,
  type ProfileMedia,
} from '@media-scraper/shared';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const DISCOVERY_TIMEOUT_MS = 90_000;
const PROFILE_RESOLUTION_TIMEOUT_MS = 30_000;
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

async function instagramProfileId(username: string) {
  const response = await fetch(
    `https://www.instagram.com/${encodeURIComponent(username)}/`,
    {
      headers: { 'user-agent': 'media-scraper/0.1' },
      signal: AbortSignal.timeout(PROFILE_RESOLUTION_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Instagram profile returned HTTP ${String(response.status)}`,
    );
  }

  const html = await response.text();
  if (Buffer.byteLength(html) > MAX_PROFILE_PAGE_BYTES) {
    throw new Error('Instagram profile page exceeded the size limit');
  }
  for (const pattern of INSTAGRAM_PROFILE_ID_PATTERNS) {
    const profileId = pattern.exec(html)?.[1];
    if (profileId) return profileId;
  }
  throw new Error('Instagram profile ID was not found');
}

async function profileUrls(platform: Platform, username: string) {
  const encodedUsername = encodeURIComponent(username);
  switch (platform) {
    case 'instagram': {
      const profileIdentifier = await instagramProfileId(username)
        .then((profileId) => `id:${profileId}`)
        .catch(() => encodedUsername);
      return [
        `https://www.instagram.com/${profileIdentifier}/posts/`,
        `https://www.instagram.com/${profileIdentifier}/reels/`,
      ];
    }
    case 'facebook':
      return [`https://www.facebook.com/${encodedUsername}/photos`];
    case 'tiktok':
      return [`https://www.tiktok.com/@${encodedUsername}/posts`];
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
      return id
        ? {
            id,
            sourceUrl: `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${id}`,
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
  url: string,
  authenticationArguments: string[],
) {
  let stdout: string;
  try {
    const result = await execFileAsync(
      'gallery-dl',
      [
        '--config-ignore',
        '--no-input',
        '--dump-json',
        '--post-range',
        `1-${String(MAX_PROFILE_MEDIA)}`,
        '--option',
        `max-posts=${String(MAX_PROFILE_MEDIA)}`,
        '--option',
        `tiktok-range=1-${String(MAX_PROFILE_MEDIA)}`,
        ...authenticationArguments,
        url,
      ],
      {
        encoding: 'utf8',
        maxBuffer: MAX_DISCOVERY_OUTPUT_BYTES,
        timeout: DISCOVERY_TIMEOUT_MS,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    throw new Error(
      'Could not read this profile. Check the username and platform authentication.',
      { cause: error },
    );
  }

  try {
    return galleryOutputSchema.parse(JSON.parse(stdout));
  } catch (error) {
    throw new Error('The profile extractor returned invalid metadata.', {
      cause: error,
    });
  }
}

export async function discoverProfileMedia(
  { platform, username }: ProfileLookup,
  cookiesPath?: string,
): Promise<ProfileMedia[]> {
  const authenticationArguments = cookiesPath ? ['--cookies', cookiesPath] : [];
  const messages: z.infer<typeof galleryOutputSchema> = [];
  const extractionErrors: Error[] = [];
  for (const url of await profileUrls(platform, username)) {
    try {
      const sourceMessages = await extractProfileSource(
        url,
        authenticationArguments,
      );
      for (const message of sourceMessages) {
        if (message[0] === GALLERY_ERROR_MESSAGE) {
          extractionErrors.push(new Error(message[1].message));
        } else {
          messages.push(message);
        }
      }
    } catch (error) {
      extractionErrors.push(
        error instanceof Error ? error : new Error('Profile extraction failed'),
      );
    }
  }

  const mediaByUrl = new Map<string, ProfileMedia>();
  let currentMedia: ProfileMedia | undefined;
  for (const message of messages) {
    if (message[0] === GALLERY_ERROR_MESSAGE) continue;

    if (message[0] === GALLERY_DIRECTORY_MESSAGE) {
      const metadata = message[1];
      const source = sourceDetails(platform, username, metadata);
      if (!source) {
        currentMedia = undefined;
        continue;
      }

      const candidate = profileMediaSchema.safeParse({
        ...source,
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

  const media = [...mediaByUrl.values()]
    .sort((left, right) =>
      (right.publishedAt ?? '').localeCompare(left.publishedAt ?? ''),
    )
    .slice(0, MAX_PROFILE_MEDIA);
  if (media.length === 0 && extractionErrors[0]) {
    throw extractionErrors[0];
  }
  return media;
}
