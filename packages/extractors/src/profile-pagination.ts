import {
  MAX_PROFILE_SOURCE_CURSOR_LENGTH,
  PROFILE_DISCOVERY_CACHE_ITEMS,
  platformSchema,
  type Platform,
} from '@media-scraper/shared';
import { z } from 'zod';

const LEGACY_PROFILE_CURSOR_VERSION = 2;
const PROFILE_CURSOR_VERSION = 3;
const profileSourceCursorSchema = z.object({
  completed: z.boolean().default(false),
  offset: z.number().int().nonnegative().safe(),
  skipKeys: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{43}$/))
    .max(PROFILE_DISCOVERY_CACHE_ITEMS),
});
const profileCursorFields = {
  platform: platformSchema,
  username: z.string().min(1).max(100),
  profileIdentifier: z
    .string()
    .regex(/^id:\d+$/)
    .optional(),
  sources: z.array(profileSourceCursorSchema).min(1).max(4),
};
const legacyProfileCursorSchema = z.object({
  version: z.literal(LEGACY_PROFILE_CURSOR_VERSION),
  ...profileCursorFields,
});
const profileCursorSchema = z.object({
  version: z.literal(PROFILE_CURSOR_VERSION),
  includeHighlights: z.boolean(),
  includeStories: z.boolean(),
  ...profileCursorFields,
});
const decodableProfileCursorSchema = z.union([
  legacyProfileCursorSchema,
  profileCursorSchema,
]);

export type ProfileSourceCursor = z.infer<typeof profileSourceCursorSchema>;

export class InvalidProfileCursorError extends Error {
  override readonly name = 'InvalidProfileCursorError';
}

interface ProfileCursorContext {
  includeHighlights: boolean;
  includeStories: boolean;
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
        (): ProfileSourceCursor => ({
          completed: false,
          offset: 0,
          skipKeys: [],
        }),
      ),
    };
  }

  try {
    const payload = decodableProfileCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (
      payload.platform !== context.platform ||
      payload.username !== context.username ||
      payload.sources.length !== context.sourceCount ||
      (payload.version === LEGACY_PROFILE_CURSOR_VERSION &&
        context.includeHighlights) ||
      (payload.version === PROFILE_CURSOR_VERSION &&
        (payload.includeStories !== context.includeStories ||
          payload.includeHighlights !== context.includeHighlights))
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
  if (cursor.length > MAX_PROFILE_SOURCE_CURSOR_LENGTH) {
    throw new Error('The profile continuation cursor exceeded its size limit.');
  }
  return cursor;
}
