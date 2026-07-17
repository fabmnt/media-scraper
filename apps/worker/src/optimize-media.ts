import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { ExtractedFile, ExtractedMedia } from '@media-scraper/extractors';
import { probeFile } from './file-metadata.js';

const AUDIO_BITRATE = '96k';
const FFMPEG_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const IMAGE_COMPRESSION_LEVEL = '4';
const IMAGE_QUALITY = '80';
const TERMINATION_GRACE_MS = 5_000;
const VIDEO_CRF = '27';
const VIDEO_FRAME_RATE = 30;
const VIDEO_PRESET = 'medium';

interface OptimizationOptions {
  imageMaxDimension: number;
  outputRoot: string;
  signal: AbortSignal;
  timeoutMs: number;
  videoMaxDimension: number;
}

function runFfmpeg(
  args: readonly string[],
  { signal, timeoutMs }: Pick<OptimizationOptions, 'signal' | 'timeoutMs'>,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', ...args],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let errorOutput = '';
    let terminalError: Error | undefined;
    let forceTermination: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceTermination) clearTimeout(forceTermination);
      signal.removeEventListener('abort', abort);
    };
    const terminate = (error: Error) => {
      if (settled || terminalError) return;
      terminalError = error;
      child.kill('SIGTERM');
      forceTermination = setTimeout(
        () => child.kill('SIGKILL'),
        TERMINATION_GRACE_MS,
      );
    };
    const abort = () =>
      terminate(new Error('Media optimization was cancelled'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => terminate(new Error('Media optimization timed out')),
      timeoutMs,
    );

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errorOutput += chunk;
      if (Buffer.byteLength(errorOutput) > FFMPEG_OUTPUT_LIMIT_BYTES) {
        terminate(new Error('ffmpeg produced too much error output'));
      }
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
      if (terminalError) {
        reject(terminalError);
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${String(code)}: ${errorOutput.trim()}`,
          ),
        );
      }
    });
  });
}

async function optimizeFile(
  file: ExtractedFile,
  options: OptimizationOptions,
): Promise<ExtractedFile> {
  const [sourceProbe, sourceStat] = await Promise.all([
    probeFile(file.absolutePath, file.type === 'image'),
    stat(file.absolutePath),
  ]);
  if (file.type === 'image' && sourceProbe.frameCount !== 1) return file;

  const outputExtension = file.type === 'video' ? '.mp4' : '.webp';
  const outputPath = join(
    dirname(file.absolutePath),
    `.${basename(file.absolutePath, extname(file.absolutePath))}.${randomUUID()}${outputExtension}`,
  );
  const maxDimension =
    file.type === 'video'
      ? options.videoMaxDimension
      : options.imageMaxDimension;
  const scaleFilter = `scale=w='min(${String(maxDimension)},iw)':h='min(${String(maxDimension)},ih)':force_original_aspect_ratio=decrease,scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'`;
  const mediaArguments =
    file.type === 'video'
      ? [
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-vf',
          sourceProbe.frameRate && sourceProbe.frameRate > VIDEO_FRAME_RATE
            ? `${scaleFilter},fps=fps=${String(VIDEO_FRAME_RATE)}`
            : scaleFilter,
          '-c:v',
          'libx264',
          '-preset',
          VIDEO_PRESET,
          '-crf',
          VIDEO_CRF,
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          AUDIO_BITRATE,
          '-movflags',
          '+faststart',
        ]
      : [
          '-vf',
          scaleFilter,
          '-frames:v',
          '1',
          '-c:v',
          'libwebp',
          '-quality',
          IMAGE_QUALITY,
          '-compression_level',
          IMAGE_COMPRESSION_LEVEL,
        ];

  try {
    await runFfmpeg(
      [
        '-y',
        '-i',
        file.absolutePath,
        '-map_metadata',
        '-1',
        ...mediaArguments,
        outputPath,
      ],
      options,
    );
    const optimizedStat = await stat(outputPath);
    const exceedsDimension =
      (sourceProbe.width ?? 0) > maxDimension ||
      (sourceProbe.height ?? 0) > maxDimension;
    if (!exceedsDimension && optimizedStat.size >= sourceStat.size) {
      await rm(outputPath, { force: true });
      return file;
    }

    const finalPath = join(
      dirname(file.absolutePath),
      `${basename(file.absolutePath)}.optimized${outputExtension}`,
    );
    await rm(finalPath, { force: true });
    await rename(outputPath, finalPath);
    await rm(file.absolutePath, { force: true });
    return {
      absolutePath: finalPath,
      relativePath: relative(options.outputRoot, finalPath),
      type: file.type,
    };
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function optimizeMedia(
  extractedItems: ExtractedMedia[],
  options: OptimizationOptions,
): Promise<ExtractedMedia[]> {
  const optimizedItems: ExtractedMedia[] = [];
  for (const item of extractedItems) {
    const files: ExtractedFile[] = [];
    for (const file of item.files) {
      options.signal.throwIfAborted();
      files.push(await optimizeFile(file, options));
    }
    optimizedItems.push({ ...item, files });
  }
  return optimizedItems;
}
