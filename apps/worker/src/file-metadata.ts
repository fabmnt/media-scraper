import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { lookup } from 'mime-types';

interface ProbeOutput {
  streams?: Array<{
    width?: number;
    height?: number;
    duration?: string;
  }>;
  format?: { duration?: string };
}

function probe(path: string): Promise<ProbeOutput> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=width,height,duration:format=duration',
      '-of',
      'json',
      path,
    ]);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', () => resolve({}));
    child.on('close', (code) => {
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

export async function readFileMetadata(path: string) {
  const [fileStat, contentHash, probeOutput] = await Promise.all([
    stat(path),
    hashFile(path),
    probe(path),
  ]);
  const stream = probeOutput.streams?.find(
    (entry) => entry.width !== undefined || entry.height !== undefined,
  );
  const rawDuration = stream?.duration ?? probeOutput.format?.duration;

  return {
    sizeBytes: fileStat.size,
    contentHash,
    mimeType: lookup(path) || 'application/octet-stream',
    width: stream?.width ?? null,
    height: stream?.height ?? null,
    durationSeconds: rawDuration ? Number(rawDuration) : null,
  };
}
