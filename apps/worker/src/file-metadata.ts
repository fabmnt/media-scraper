import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { lookup } from 'mime-types';

const PROBE_TIMEOUT_MS = 30_000;

interface ProbeOutput {
  streams?: Array<{
    width?: number;
    height?: number;
    duration?: string;
    r_frame_rate?: string;
  }>;
  format?: { duration?: string };
}

function probe(path: string): Promise<ProbeOutput> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=width,height,duration,r_frame_rate:format=duration',
      '-of',
      'json',
      path,
    ]);
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), PROBE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.resume();
    child.on('error', () => resolve({}));
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(output) as ProbeOutput);
      } catch {
        resolve({});
      }
    });
  });
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function probeFile(path: string) {
  const probeOutput = await probe(path);
  const stream = probeOutput.streams?.find(
    (entry) => entry.width !== undefined || entry.height !== undefined,
  );
  const rawDuration = stream?.duration ?? probeOutput.format?.duration;
  const parsedDuration = rawDuration ? Number(rawDuration) : undefined;
  const [frameRateNumerator, frameRateDenominator] = (
    stream?.r_frame_rate ?? ''
  )
    .split('/')
    .map(Number);
  const frameRate =
    frameRateNumerator !== undefined &&
    frameRateDenominator !== undefined &&
    Number.isFinite(frameRateNumerator) &&
    Number.isFinite(frameRateDenominator) &&
    frameRateDenominator > 0
      ? frameRateNumerator / frameRateDenominator
      : null;

  return {
    durationSeconds:
      parsedDuration !== undefined &&
      Number.isFinite(parsedDuration) &&
      parsedDuration >= 0
        ? parsedDuration
        : null,
    frameRate,
    height: stream?.height ?? null,
    width: stream?.width ?? null,
  };
}

export async function readFileMetadata(path: string) {
  const [fileStat, contentHash, fileProbe] = await Promise.all([
    stat(path),
    hashFile(path),
    probeFile(path),
  ]);

  return {
    sizeBytes: fileStat.size,
    contentHash,
    mimeType: lookup(path) || 'application/octet-stream',
    width: fileProbe.width,
    height: fileProbe.height,
    durationSeconds: fileProbe.durationSeconds,
  };
}
