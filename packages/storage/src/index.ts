import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const DELETE_CONCURRENCY = 4;

export interface S3StorageOptions {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle: boolean;
  presignedUrlTtlSeconds: number;
  region: string;
  secretAccessKey: string;
}

export type MediaStorageOptions =
  | { driver: 'local'; mediaRoot: string }
  | ({ driver: 's3'; mediaRoot: string } & S3StorageOptions);

export interface StoredAssetLocation {
  relativePath: string | null;
  storageKey: string | null;
}

export class StorageUploadError extends Error {
  readonly location: StoredAssetLocation;

  constructor(storageKey: string, cause: unknown) {
    super(`Failed to upload object ${storageKey}`, { cause });
    this.name = 'StorageUploadError';
    this.location = { relativePath: null, storageKey };
  }
}

export class MediaStorage {
  readonly driver: MediaStorageOptions['driver'];
  readonly mediaRoot: string;
  private readonly bucket?: string;
  private readonly presignedUrlTtlSeconds?: number;
  private readonly s3?: S3Client;

  constructor(options: MediaStorageOptions) {
    this.driver = options.driver;
    this.mediaRoot = resolve(options.mediaRoot);
    if (options.driver === 's3') {
      this.bucket = options.bucket;
      this.presignedUrlTtlSeconds = options.presignedUrlTtlSeconds;
      this.s3 = new S3Client({
        endpoint: options.endpoint,
        forcePathStyle: options.forcePathStyle,
        region: options.region,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      });
    }
  }

  localPath(relativePath: string) {
    const absolutePath = resolve(this.mediaRoot, relativePath);
    return absolutePath.startsWith(`${this.mediaRoot}${sep}`)
      ? absolutePath
      : undefined;
  }

  async store(
    absolutePath: string,
    contentHash: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<StoredAssetLocation> {
    signal?.throwIfAborted();
    if (this.driver === 'local') {
      const relativePath = relative(this.mediaRoot, absolutePath);
      if (!this.localPath(relativePath)) {
        throw new Error('Media file is outside the configured storage root');
      }
      return { relativePath, storageKey: null };
    }
    if (!this.s3 || !this.bucket) {
      throw new Error('S3 storage is not configured');
    }

    const storageKey = `media/${contentHash.slice(0, 2)}/${contentHash}-${randomUUID()}`;
    try {
      const fileStat = await stat(absolutePath);
      await this.s3.send(
        new PutObjectCommand({
          Body: createReadStream(absolutePath),
          Bucket: this.bucket,
          ContentLength: fileStat.size,
          ContentType: mimeType,
          Key: storageKey,
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      return { relativePath: null, storageKey };
    } catch (error) {
      throw new StorageUploadError(storageKey, error);
    }
  }

  async createReadUrl(storageKey: string, downloadFileName?: string) {
    if (!this.s3 || !this.bucket || !this.presignedUrlTtlSeconds) {
      throw new Error('S3 storage is not configured');
    }
    const safeFileName = downloadFileName?.replace(/["\r\n]/g, '_');
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ...(safeFileName
          ? {
              ResponseContentDisposition: `attachment; filename="${safeFileName}"`,
            }
          : {}),
      }),
      { expiresIn: this.presignedUrlTtlSeconds },
    );
  }

  async getObject(storageKey: string, range?: string) {
    if (!this.s3 || !this.bucket) {
      throw new Error('S3 storage is not configured');
    }
    return this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ...(range ? { Range: range } : {}),
      }),
    );
  }

  async deleteObjects(storageKeys: readonly string[], signal?: AbortSignal) {
    const uniqueKeys = [...new Set(storageKeys)];
    if (uniqueKeys.length === 0) return;
    const s3 = this.s3;
    const bucket = this.bucket;
    if (!s3 || !bucket) throw new Error('S3 storage is not configured');

    let nextIndex = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(DELETE_CONCURRENCY, uniqueKeys.length) },
        async () => {
          while (nextIndex < uniqueKeys.length) {
            signal?.throwIfAborted();
            const storageKey = uniqueKeys[nextIndex];
            nextIndex += 1;
            if (!storageKey) continue;
            await s3.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }),
              signal ? { abortSignal: signal } : undefined,
            );
          }
        },
      ),
    );
  }

  close() {
    this.s3?.destroy();
  }
}
