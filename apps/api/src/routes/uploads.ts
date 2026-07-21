import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromFile } from 'file-type';
import type { FastifyInstance } from 'fastify';
import { createThumbnail } from '@media-scraper/media-processing';
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
import {
  MediaStorage,
  StorageUploadError,
  type StoredAssetLocation,
} from '@media-scraper/storage';
import { serializeMediaItem } from '../serialization.js';

const UPLOAD_DIRECTORY_NAME = 'uploads';
const UPLOAD_FILE_FIELD_NAME = 'files';
const UPLOAD_METADATA_FIELDS = new Set(['platform', 'username']);
const UNSAFE_IMAGE_MIME_TYPE = 'image/svg+xml';
const STORE_CONCURRENCY = 4;

interface UploadedThumbnail {
  absolutePath: string;
  contentHash: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  type: 'image';
}

interface UploadedFile {
  absolutePath: string;
  contentHash: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  thumbnail?: UploadedThumbnail;
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

function assetTooLargeError(fileName: string) {
  return Object.assign(
    new Error(`${fileName} exceeds the configured asset limit`),
    { statusCode: 413 },
  );
}

function collectionTooLargeError() {
  return Object.assign(
    new Error('Upload exceeds the configured total size limit'),
    { statusCode: 413 },
  );
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

async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function writeUploadedFile(
  stream: NodeJS.ReadableStream,
  absolutePath: string,
): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    stream,
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(absolutePath, { flags: 'wx' }),
  );
  return hash.digest('hex');
}

async function describeUploadedFile(
  absolutePath: string,
  fileName: string,
  declaredMimeType: string,
  contentHash: string,
): Promise<UploadedFile> {
  const declaredType = uploadedMediaType(declaredMimeType);
  const detectedFileType = await fileTypeFromFile(absolutePath);
  if (!detectedFileType) {
    throw badUploadRequest('Could not identify the uploaded media type');
  }

  const type = uploadedMediaType(detectedFileType.mime);
  if (type !== declaredType) {
    throw badUploadRequest(
      'Uploaded media type does not match its file content',
    );
  }

  const fileStat = await stat(absolutePath);
  return {
    absolutePath,
    contentHash,
    fileName,
    mimeType: detectedFileType.mime,
    sizeBytes: fileStat.size,
    type,
  };
}

async function queueFailedUploadCleanup(
  db: Database,
  locations: Iterable<StoredAssetLocation>,
) {
  const storedObjects = [...locations].filter(
    (location) => location.storageKey,
  );
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
    const storedLocations = new Map<string, StoredAssetLocation>();
    let totalBytes = 0;
    let completed = false;

    await mkdir(uploadDirectory, { recursive: true });
    try {
      let uploadError: Error | undefined;
      for await (const part of request.parts()) {
        if (uploadError) {
          if (part.type === 'file') part.file.resume();
          continue;
        }

        try {
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
          const absolutePath = join(
            uploadDirectory,
            `${String(files.length)}-${fileName}`,
          );
          const contentHash = await writeUploadedFile(part.file, absolutePath);
          if (part.file.truncated) throw assetTooLargeError(fileName);

          const uploadedFile = await describeUploadedFile(
            absolutePath,
            fileName,
            part.mimetype.toLowerCase(),
            contentHash,
          );
          totalBytes += uploadedFile.sizeBytes;
          if (totalBytes > maxCollectionBytes) {
            throw collectionTooLargeError();
          }
          files.push(uploadedFile);
        } catch (error) {
          if (part.type === 'file') part.file.resume();
          uploadError =
            error instanceof Error ? error : new Error(String(error));
        }
      }

      if (uploadError) throw uploadError;
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
        const thumbnailFile = await createThumbnail(file, uploadDirectory);
        if (!thumbnailFile) continue;
        const thumbnail = await describeUploadedFile(
          thumbnailFile.absolutePath,
          thumbnailFile.relativePath,
          'image/jpeg',
          await hashFile(thumbnailFile.absolutePath),
        );
        file.thumbnail = { ...thumbnail, type: 'image' };
      }
      let nextFileIndex = 0;
      const storeResults = await Promise.allSettled(
        Array.from(
          { length: Math.min(STORE_CONCURRENCY, files.length) },
          async () => {
            const filesToStore = files.flatMap((file) =>
              file.thumbnail ? [file, file.thumbnail] : [file],
            );
            while (nextFileIndex < filesToStore.length) {
              const file = filesToStore[nextFileIndex];
              nextFileIndex += 1;
              if (!file) continue;
              try {
                storedLocations.set(
                  file.absolutePath,
                  await storage.store(
                    file.absolutePath,
                    file.contentHash,
                    file.mimeType,
                  ),
                );
              } catch (error) {
                if (error instanceof StorageUploadError) {
                  storedLocations.set(file.absolutePath, error.location);
                }
                throw error;
              }
            }
          },
        ),
      );
      const failedStore = storeResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failedStore) throw failedStore.reason;

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

        const originals = await transaction
          .insert(mediaAssets)
          .values(
            files.map((file, position) => {
              const location = storedLocations.get(file.absolutePath);
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
        const thumbnails = files.flatMap((file, position) => {
          const thumbnail = file.thumbnail;
          const original = originals[position];
          if (!thumbnail || !original) return [];
          const location = storedLocations.get(thumbnail.absolutePath);
          if (!location) throw new Error('Uploaded thumbnail was not stored');
          return [
            {
              ...location,
              contentHash: thumbnail.contentHash,
              fileName: thumbnail.fileName,
              mediaItemId: mediaItem.id,
              mimeType: thumbnail.mimeType,
              position: files.length + position,
              sizeBytes: thumbnail.sizeBytes,
              thumbnailForAssetId: original.id,
              type: thumbnail.type,
            },
          ];
        });
        const assets =
          thumbnails.length > 0
            ? await transaction
                .insert(mediaAssets)
                .values(thumbnails)
                .returning()
            : [];
        await enqueueRetention(transaction);
        return serializeMediaItem(mediaItem, [...originals, ...assets]);
      });
      completed = true;
      return reply.code(201).send(result);
    } catch (error) {
      await queueFailedUploadCleanup(db, storedLocations.values()).catch(
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
