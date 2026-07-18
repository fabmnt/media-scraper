import {
  MAX_PROFILE_CURSOR_LENGTH,
  PROFILE_DISCOVERY_CACHE_ITEMS,
  platformSchema,
  type Platform,
} from '@media-scraper/shared';
import { z } from 'zod';

const PROFILE_CURSOR_VERSION = 1;
const profileSourceCursorSchema = z.object({
  offset: z.number().int().nonnegative().safe(),
  skipUrls: z.array(z.url()).max(PROFILE_DISCOVERY_CACHE_ITEMS),
});
const profileCursorSchema = z.object({
  version: z.literal(PROFILE_CURSOR_VERSION),
  platform: platformSchema,
  username: z.string().min(1).max(100),
  profileIdentifier: z
    .string()
    .regex(/^id:\d+$/)
    .optional(),
  sources: z.array(profileSourceCursorSchema).min(1).max(2),
});

export type ProfileSourceCursor = z.infer<typeof profileSourceCursorSchema>;

export class InvalidProfileCursorError extends Error {
  override readonly name = 'InvalidProfileCursorError';
}

interface ProfileCursorContext {
  platform: Platform;
  username: string;
  sourceCount: number;
}

export function decodeProfileCursor(
  cursor: string | undefined,
  context: ProfileCursorContext,
) {
  if (cursor === undefined) {
    return {
      profileIdentifier: undefined,
      sources: Array.from(
        { length: context.sourceCount },
        (): ProfileSourceCursor => ({ offset: 0, skipUrls: [] }),
      ),
    };
  }

  try {
    const payload = profileCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (
      payload.platform !== context.platform ||
      payload.username !== context.username ||
      payload.sources.length !== context.sourceCount
    ) {
      throw new Error('Cursor does not match this profile');
    }
    return {
      profileIdentifier: payload.profileIdentifier,
      sources: payload.sources,
    };
  } catch (error) {
    throw new InvalidProfileCursorError(
      'The profile continuation cursor is invalid.',
      { cause: error },
    );
  }
}

export function encodeProfileCursor(
  context: ProfileCursorContext,
  sources: ProfileSourceCursor[],
  profileIdentifier?: string,
) {
  const cursor = Buffer.from(
    JSON.stringify(
      profileCursorSchema.parse({
        version: PROFILE_CURSOR_VERSION,
        ...context,
        profileIdentifier,
        sources,
      }),
    ),
  ).toString('base64url');
  if (cursor.length > MAX_PROFILE_CURSOR_LENGTH) {
    throw new Error('The profile continuation cursor exceeded its size limit.');
  }
  return cursor;
}
