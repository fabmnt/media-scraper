import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { spawn } from 'node:child_process';

const VIDEO_EXTENSIONS = new Set(['.m4v', '.mkv', '.mov', '.mp4', '.webm']);
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
]);
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_DOWNLOAD_HEIGHT = 720;
const OUTPUT_CHECK_INTERVAL_MS = 1_000;
const TERMINATION_GRACE_MS = 5_000;

class TerminalExtractionError extends Error {
  override readonly name = 'TerminalExtractionError';
}

export interface ExtractedFile {
  absolutePath: string;
  relativePath: string;
  type: 'image' | 'video';
}

export type ExtractorName = 'gallery-dl' | 'yt-dlp';

export interface ExtractionOptions {
  cookiesPath?: string;
  maxAssetBytes: number;
  maxCollectionBytes: number;
  preferredExtractor?: ExtractorName;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ExtractedMedia {
  sourceId: string;
  sourceUrl: string;
  authorName: string | null;
  caption: string | null;
  publishedAt: Date | null;
  files: ExtractedFile[];
}

interface YtDlpMetadata {
  id?: string;
  webpage_url?: string;
  original_url?: string;
  uploader?: string;
  channel?: string;
  description?: string;
  title?: string;
  timestamp?: number;
}

interface GalleryDlMetadata {
  id?: string | number;
  post_id?: string | number;
  shortcode?: string;
  username?: string;
  fullname?: string;
  description?: string;
  caption?: string;
  title?: string;
  date?: string | number;
  timestamp?: string | number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function validateOutputSize(
  root: string,
  maxAssetBytes: number,
  maxCollectionBytes: number,
) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fileSize = (await stat(join(entry.parentPath, entry.name))).size;
    if (fileSize > maxAssetBytes) {
      throw new Error(`${entry.name} exceeds the configured asset limit`);
    }
    totalBytes += fileSize;
    if (totalBytes > maxCollectionBytes) {
      throw new Error('Collection exceeds the configured total size limit');
    }
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  outputDirectory: string,
  options: ExtractionOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let terminalError: Error | undefined;
    let checkingOutput = false;
    let forceTermination: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(outputCheck);
      if (forceTermination) clearTimeout(forceTermination);
      options.signal?.removeEventListener('abort', abort);
    };
    const terminate = (error: Error) => {
      if (settled || terminalError) return;
      terminalError =
        error instanceof TerminalExtractionError
          ? error
          : new TerminalExtractionError(error.message, { cause: error });
      child.kill('SIGTERM');
      forceTermination = setTimeout(
        () => child.kill('SIGKILL'),
        TERMINATION_GRACE_MS,
      );
    };
    const abort = () =>
      terminate(new TerminalExtractionError(`${command} was cancelled`));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () =>
        terminate(
          new TerminalExtractionError(
            `${command} exceeded the extraction timeout`,
          ),
        ),
      options.timeoutMs,
    );
    const outputCheck = setInterval(() => {
      if (checkingOutput || terminalError) return;
      checkingOutput = true;
      void validateOutputSize(
        outputDirectory,
        options.maxAssetBytes,
        options.maxCollectionBytes,
      )
        .catch((error: unknown) =>
          terminate(error instanceof Error ? error : new Error(String(error))),
        )
        .finally(() => {
          checkingOutput = false;
        });
    }, OUTPUT_CHECK_INTERVAL_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES) {
        terminate(new Error(`${command} produced too much metadata output`));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_COMMAND_OUTPUT_BYTES) {
        terminate(new Error(`${command} produced too much error output`));
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
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} exited with code ${String(code)}: ${stderr.trim()}`,
        ),
      );
    });
  });
}

async function findMediaFiles(root: string): Promise<ExtractedFile[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .flatMap((entry) => {
      if (!entry.isFile()) return [];

      const absolutePath = join(entry.parentPath, entry.name);
      const extension = extname(entry.name).toLowerCase();
      const type: ExtractedFile['type'] | undefined = VIDEO_EXTENSIONS.has(
        extension,
      )
        ? 'video'
        : IMAGE_EXTENSIONS.has(extension)
          ? 'image'
          : undefined;

      return type
        ? [{ absolutePath, relativePath: relative(root, absolutePath), type }]
        : [];
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function parseYtDlpMetadata(output: string): YtDlpMetadata[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as YtDlpMetadata];
      } catch {
        return [];
      }
    });
}

function sourceIdForUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

async function extractWithYtDlp(
  url: string,
  outputDirectory: string,
  options: ExtractionOptions,
): Promise<ExtractedMedia[]> {
  const outputTemplate = join(
    outputDirectory,
    '%(extractor)s',
    '%(id)s',
    '%(title).180B [%(id)s].%(ext)s',
  );
  const authenticationArguments = options.cookiesPath
    ? ['--cookies', options.cookiesPath]
    : [];
  const { stdout } = await runCommand(
    'yt-dlp',
    [
      ...authenticationArguments,
      '--max-filesize',
      String(options.maxAssetBytes),
      '--no-progress',
      '--newline',
      '--write-thumbnail',
      '--convert-thumbnails',
      'jpg',
      '--merge-output-format',
      'mp4',
      '--format',
      `bv*[height<=${String(MAX_VIDEO_DOWNLOAD_HEIGHT)}]+ba/b[height<=${String(MAX_VIDEO_DOWNLOAD_HEIGHT)}]/best[height<=${String(MAX_VIDEO_DOWNLOAD_HEIGHT)}]/best`,
      '--output',
      outputTemplate,
      '--print',
      'after_move:%()j',
      url,
    ],
    outputDirectory,
    options,
  );
  const files = await findMediaFiles(outputDirectory);
  if (files.length === 0)
    throw new Error('yt-dlp did not produce any media files');

  const metadata = parseYtDlpMetadata(stdout);
  if (metadata.length === 0) {
    return [
      {
        sourceId: sourceIdForUrl(url),
        sourceUrl: url,
        authorName: null,
        caption: null,
        publishedAt: null,
        files,
      },
    ];
  }

  return metadata.flatMap((item) => {
    const itemId = item.id;
    const itemFiles =
      metadata.length === 1 || !itemId
        ? files
        : files.filter((file) =>
            file.relativePath.split(/[\\/]/).includes(itemId),
          );
    if (itemFiles.length === 0) return [];

    return [
      {
        sourceId: item.id ?? sourceIdForUrl(item.webpage_url ?? url),
        sourceUrl: item.webpage_url ?? item.original_url ?? url,
        authorName: item.uploader ?? item.channel ?? null,
        caption: item.description ?? item.title ?? null,
        publishedAt: item.timestamp ? new Date(item.timestamp * 1_000) : null,
        files: itemFiles,
      },
    ];
  });
}

async function readGalleryDlMetadata(
  outputDirectory: string,
): Promise<GalleryDlMetadata[]> {
  const entries = await readdir(outputDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  const metadata: GalleryDlMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const contents = await readFile(
        join(entry.parentPath, entry.name),
        'utf8',
      );
      metadata.push(JSON.parse(contents) as GalleryDlMetadata);
    } catch {
      // A malformed sidecar should not discard successfully downloaded media.
    }
  }
  return metadata;
}

async function extractWithGalleryDl(
  url: string,
  outputDirectory: string,
  options: ExtractionOptions,
): Promise<ExtractedMedia[]> {
  const authenticationArguments = options.cookiesPath
    ? ['--cookies', options.cookiesPath]
    : [];
  await runCommand(
    'gallery-dl',
    [
      ...authenticationArguments,
      '--write-metadata',
      '--destination',
      outputDirectory,
      url,
    ],
    outputDirectory,
    options,
  );
  const files = await findMediaFiles(outputDirectory);
  if (files.length === 0) {
    throw new Error('gallery-dl did not produce any media files');
  }

  const metadata = await readGalleryDlMetadata(outputDirectory);
  const sourceIdentifier = metadata.find(
    (item) => item.shortcode ?? item.post_id ?? item.id,
  );
  const author = metadata.find((item) => item.username ?? item.fullname);
  const text = metadata.find(
    (item) => item.description ?? item.caption ?? item.title,
  );
  const publication = metadata.find((item) => item.date ?? item.timestamp);
  const publicationValue = publication?.date ?? publication?.timestamp;
  const publishedAt = publicationValue
    ? new Date(
        typeof publicationValue === 'number'
          ? publicationValue * 1_000
          : publicationValue,
      )
    : null;

  return [
    {
      sourceId: String(
        sourceIdentifier?.shortcode ??
          sourceIdentifier?.post_id ??
          sourceIdentifier?.id ??
          sourceIdForUrl(url),
      ),
      sourceUrl: url,
      authorName: author?.username ?? author?.fullname ?? null,
      caption: text?.description ?? text?.caption ?? text?.title ?? null,
      publishedAt:
        publishedAt && !Number.isNaN(publishedAt.getTime())
          ? publishedAt
          : null,
      files,
    },
  ];
}

export async function extractMedia(
  url: string,
  outputDirectory: string,
  options: ExtractionOptions,
): Promise<ExtractedMedia[]> {
  const preferredExtractor = options.preferredExtractor ?? 'yt-dlp';
  const primaryExtraction =
    preferredExtractor === 'gallery-dl'
      ? extractWithGalleryDl
      : extractWithYtDlp;
  const fallbackExtractor =
    preferredExtractor === 'gallery-dl'
      ? extractWithYtDlp
      : extractWithGalleryDl;
  const fallbackName: ExtractorName =
    preferredExtractor === 'gallery-dl' ? 'yt-dlp' : 'gallery-dl';

  const deadline = Date.now() + options.timeoutMs;
  try {
    return await primaryExtraction(url, outputDirectory, options);
  } catch (primaryError) {
    if (primaryError instanceof TerminalExtractionError) throw primaryError;
    const remainingTimeMs = deadline - Date.now();
    if (remainingTimeMs <= 0) {
      throw new TerminalExtractionError('Extraction deadline exceeded', {
        cause: primaryError,
      });
    }
    await rm(outputDirectory, { force: true, recursive: true });
    await mkdir(outputDirectory, { recursive: true });
    try {
      return await fallbackExtractor(url, outputDirectory, {
        ...options,
        timeoutMs: remainingTimeMs,
      });
    } catch (fallbackError) {
      const primaryMessage =
        primaryError instanceof Error
          ? primaryError.message
          : String(primaryError);
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new AggregateError(
        [primaryError, fallbackError],
        `No extractor could download this URL. ${preferredExtractor}: ${primaryMessage}; ${fallbackName}: ${fallbackMessage}`,
      );
    }
  }
}
