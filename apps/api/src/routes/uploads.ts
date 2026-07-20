import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import {
  collections,
  enqueueAssetCleanup,
  enqueueRetention,
  mediaAssets,
  mediaItems,
  type Database,
} from '@media-scraper/database';
import {
  MANUAL_UPLOAD_PLATFORM,
  manualUploadInputSchema,
  type MediaType,
} from '@media-scraper/shared';
import type { MediaStorage, StoredAssetLocation } from '@media-scraper/storage';
import { serializeMediaItem } from '../serialization.js';

const UPLOAD_DIRECTORY_NAME = 'uploads';
const UPLOAD_FILE_FIELD_NAME = 'files';
const UPLOAD_METADATA_FIELDS = new Set(['platform', 'username']);
const UNSAFE_IMAGE_MIME_TYPE = 'image/svg+xml';

interface UploadedFile {
  absolutePath: string;
  contentHash: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  type: MediaType;
}

interface UploadRoutesOptions {
  db: Database;
  maxCollectionBytes: number;
  storage: MediaStorage;
}

function badUploadRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function uploadedMediaType(mimeType: string): MediaType {
  const normalizedMimeType = mimeType.toLowerCase();
  if (
    normalizedMimeType.startsWith('image/') &&
    normalizedMimeType !== UNSAFE_IMAGE_MIME_TYPE
  ) {
    return 'image';
  }
  if (normalizedMimeType.startsWith('video/')) return 'video';
  throw badUploadRequest('Only images, GIFs, and videos can be uploaded');
}

function safeFileName(fileName: string) {
  const normalizedFileName = basename(fileName).replace(/[\r\n]/g, '_');
  if (!normalizedFileName || normalizedFileName === '.') {
    throw badUploadRequest('Each uploaded file must have a name');
  }
  return normalizedFileName;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function describeUploadedFile(
  absolutePath: string,
  fileName: string,
  mimeType: string,
  type: MediaType,
): Promise<UploadedFile> {
  const [fileStat, contentHash] = await Promise.all([
    stat(absolutePath),
    hashFile(absolutePath),
  ]);
  return {
    absolutePath,
    contentHash,
    fileName,
    mimeType,
    sizeBytes: fileStat.size,
    type,
  };
}

async function queueFailedUploadCleanup(
  db: Database,
  locations: StoredAssetLocation[],
) {
  const storedObjects = locations.filter((location) => location.storageKey);
  if (storedObjects.length === 0) return;
  await db.transaction((transaction) =>
    enqueueAssetCleanup(transaction, storedObjects),
  );
}

export async function uploadRoutes(
  app: FastifyInstance,
  { db, maxCollectionBytes, storage }: UploadRoutesOptions,
) {
  app.post('/', { schema: { tags: ['uploads'] } }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(415).send({ message: 'Use multipart/form-data' });
    }

    const collectionId = randomUUID();
    const uploadDirectory = resolve(
      storage.mediaRoot,
      UPLOAD_DIRECTORY_NAME,
      collectionId,
    );
    if (!uploadDirectory.startsWith(`${storage.mediaRoot}${sep}`)) {
      throw new Error('Invalid upload directory');
    }

    const fields: Record<string, string> = {};
    const files: UploadedFile[] = [];
    const storedLocations: StoredAssetLocation[] = [];
    let totalBytes = 0;
    let completed = false;

    await mkdir(uploadDirectory, { recursive: true });
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (
            !UPLOAD_METADATA_FIELDS.has(part.fieldname) ||
            fields[part.fieldname] !== undefined ||
            part.valueTruncated
          ) {
            throw badUploadRequest('Invalid upload metadata');
          }
          fields[part.fieldname] = String(part.value);
          continue;
        }

        if (part.fieldname !== UPLOAD_FILE_FIELD_NAME || !part.filename) {
          part.file.resume();
          throw badUploadRequest('Invalid upload file field');
        }

        const fileName = safeFileName(part.filename);
        const type = uploadedMediaType(part.mimetype);
        const absolutePath = join(
          uploadDirectory,
          `${String(files.length)}-${fileName}`,
        );
        await pipeline(
          part.file,
          createWriteStream(absolutePath, { flags: 'wx' }),
        );
        if (part.file.truncated) {
          throw Object.assign(
            new Error(`${fileName} exceeds the configured asset limit`),
            {
              statusCode: 413,
            },
          );
        }

        const uploadedFile = await describeUploadedFile(
          absolutePath,
          fileName,
          part.mimetype.toLowerCase(),
          type,
        );
        totalBytes += uploadedFile.sizeBytes;
        if (totalBytes > maxCollectionBytes) {
          throw Object.assign(
            new Error('Upload exceeds the configured total size limit'),
            { statusCode: 413 },
          );
        }
        files.push(uploadedFile);
      }

      if (files.length === 0) {
        throw badUploadRequest('Select at least one media file to upload');
      }
      if (
        new Set(files.map((file) => file.contentHash)).size !== files.length
      ) {
        throw badUploadRequest('A gallery cannot include duplicate files');
      }

      const input = manualUploadInputSchema.parse({
        platform: fields.platform || undefined,
        username: fields.username || undefined,
      });
      const platform = input.platform ?? MANUAL_UPLOAD_PLATFORM;
      for (const file of files) {
        storedLocations.push(
          await storage.store(
            file.absolutePath,
            file.contentHash,
            file.mimeType,
          ),
        );
      }

      const result = await db.transaction(async (transaction) => {
        await transaction.insert(collections).values({
          id: collectionId,
          origin: 'upload',
          platform,
          sourceUrl: null,
          status: 'completed',
        });
        const [mediaItem] = await transaction
          .insert(mediaItems)
          .values({
            authorName: input.username ?? null,
            collectionId,
            platform,
            sourceId: randomUUID(),
            sourceUrl: null,
          })
          .returning();
        if (!mediaItem) throw new Error('Failed to save uploaded media');

        const assets = await transaction
          .insert(mediaAssets)
          .values(
            files.map((file, position) => {
              const location = storedLocations[position];
              if (!location) throw new Error('Uploaded media was not stored');
              return {
                ...location,
                contentHash: file.contentHash,
                fileName: file.fileName,
                mediaItemId: mediaItem.id,
                mimeType: file.mimeType,
                position,
                sizeBytes: file.sizeBytes,
                type: file.type,
              };
            }),
          )
          .returning();
        await enqueueRetention(transaction);
        return serializeMediaItem(mediaItem, assets);
      });
      completed = true;
      return reply.code(201).send(result);
    } catch (error) {
      await queueFailedUploadCleanup(db, storedLocations).catch(
        (cleanupError) =>
          request.log.error(
            cleanupError,
            'Could not queue failed upload cleanup',
          ),
      );
      throw error;
    } finally {
      if (!completed || storage.driver === 's3') {
        await rm(uploadDirectory, { force: true, recursive: true }).catch(
          (cleanupError) =>
            request.log.error(
              cleanupError,
              'Could not remove upload workspace',
            ),
        );
      }
    }
  });
}
