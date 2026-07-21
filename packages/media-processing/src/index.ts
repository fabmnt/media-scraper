import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';

const THUMBNAIL_MAX_DIMENSION = 480;
const THUMBNAIL_TIMEOUT_MS = 30_000;
const DEFAULT_VIDEO_THUMBNAIL_TIMESTAMP_SECONDS = 0;
const PREFERRED_VIDEO_THUMBNAIL_TIMESTAMP_SECONDS = 1;
const TERMINATION_GRACE_MS = 5_000;

export interface MediaFile {
  absolutePath: string;
  durationSeconds?: number | null;
  relativePath: string;
  type: 'image' | 'video';
}

export interface ThumbnailFile {
  absolutePath: string;
  relativePath: string;
  type: 'image';
}

function runFfmpeg(
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', ...arguments_],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let output = '';
    let forceTermination: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceTermination) clearTimeout(forceTermination);
      signal?.removeEventListener('abort', abort);
    };
    const terminate = () => {
      child.kill('SIGTERM');
      forceTermination = setTimeout(
        () => child.kill('SIGKILL'),
        TERMINATION_GRACE_MS,
      );
    };
    const abort = () => terminate();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(terminate, THUMBNAIL_TIMEOUT_MS);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg thumbnail generation failed: ${output.trim()}`));
    });
  });
}

export async function createThumbnail(
  file: Pick<MediaFile, 'absolutePath' | 'durationSeconds' | 'type'>,
  outputRoot: string,
  signal?: AbortSignal,
  onFailure?: (error: unknown) => void,
): Promise<ThumbnailFile | undefined> {
  const outputPath = join(
    dirname(file.absolutePath),
    `.${basename(file.absolutePath, extname(file.absolutePath))}.thumbnail.jpg`,
  );
  const scaleFilter = `scale=w='min(${String(THUMBNAIL_MAX_DIMENSION)},iw)':h='min(${String(THUMBNAIL_MAX_DIMENSION)},ih)':force_original_aspect_ratio=decrease`;
  const thumbnailTimestamp =
    file.durationSeconds === null || file.durationSeconds === undefined
      ? DEFAULT_VIDEO_THUMBNAIL_TIMESTAMP_SECONDS
      : Math.min(
          PREFERRED_VIDEO_THUMBNAIL_TIMESTAMP_SECONDS,
          file.durationSeconds / 2,
        );

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await runFfmpeg(
      [
        '-y',
        ...(file.type === 'video' ? ['-ss', String(thumbnailTimestamp)] : []),
        '-i',
        file.absolutePath,
        '-frames:v',
        '1',
        '-vf',
        scaleFilter,
        '-q:v',
        '4',
        outputPath,
      ],
      signal,
    );
    return {
      absolutePath: outputPath,
      relativePath: relative(outputRoot, outputPath),
      type: 'image',
    };
  } catch (error) {
    onFailure?.(error);
    await rm(outputPath, { force: true }).catch(() => undefined);
    return undefined;
  }
}
