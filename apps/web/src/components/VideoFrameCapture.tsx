import { useRef, useState } from 'react';

const FRAME_IMAGE_MIME_TYPE = 'image/jpeg';
const FRAME_IMAGE_QUALITY = 0.92;
const FRAME_SEEK_STEP_SECONDS = 0.01;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

type VideoFrameCaptureProps = {
  fileName: string;
  src: string;
};

function formatTime(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor(
    (wholeSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE,
  );
  const remainingSeconds = wholeSeconds % SECONDS_PER_MINUTE;
  const formattedMinutes =
    hours > 0 ? String(minutes).padStart(2, '0') : minutes;
  const formattedSeconds = String(remainingSeconds).padStart(2, '0');

  return hours > 0
    ? `${hours}:${formattedMinutes}:${formattedSeconds}`
    : `${formattedMinutes}:${formattedSeconds}`;
}

function getFrameFileName(fileName: string, seconds: number) {
  const name = fileName.replace(/\.[^/.]+$/, '') || 'video';
  return `${name}-frame-${Math.round(seconds)}s.jpg`;
}

function waitForSeek(video: HTMLVideoElement) {
  if (!video.seeking) return Promise.resolve();
  return new Promise<void>((resolve) => {
    video.addEventListener('seeked', () => resolve(), { once: true });
  });
}

function captureFrame(video: HTMLVideoElement) {
  return new Promise<Blob>((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');

    if (!context) {
      reject(new Error('Image capture is not supported by this browser.'));
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The video frame could not be captured.'));
      },
      FRAME_IMAGE_MIME_TYPE,
      FRAME_IMAGE_QUALITY,
    );
  });
}

function downloadBlob(blob: Blob, fileName: string) {
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
}

export function VideoFrameCapture({ fileName, src }: VideoFrameCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string>();

  function updateCurrentTime(time: number) {
    if (!Number.isFinite(time)) return;
    setCurrentTime(time);
  }

  function seekTo(time: number) {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = time;
    updateCurrentTime(time);
  }

  async function downloadFrame() {
    const video = videoRef.current;
    if (!video) {
      setError('Wait for the video frame to load before downloading it.');
      return;
    }

    setIsDownloading(true);
    setError(undefined);
    try {
      await waitForSeek(video);
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        throw new Error('The video frame is not ready.');
      }
      const blob = await captureFrame(video);
      downloadBlob(blob, getFrameFileName(fileName, video.currentTime));
    } catch {
      setError('The video frame could not be downloaded.');
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <div className="video-frame-preview">
      <video
        aria-label="Video preview"
        autoPlay
        controls
        onLoadedMetadata={(event) => {
          const videoDuration = event.currentTarget.duration;
          setDuration(Number.isFinite(videoDuration) ? videoDuration : 0);
          updateCurrentTime(event.currentTarget.currentTime);
        }}
        onTimeUpdate={(event) =>
          updateCurrentTime(event.currentTarget.currentTime)
        }
        ref={videoRef}
        src={src}
      />
      <div className="video-frame-controls">
        <div className="video-frame-toolbar">
          <label htmlFor="video-frame-position">Choose a moment</label>
          <output htmlFor="video-frame-position">
            {formatTime(currentTime)} / {formatTime(duration)}
          </output>
        </div>
        <input
          aria-label="Choose video moment"
          disabled={!duration}
          id="video-frame-position"
          max={duration}
          min="0"
          onChange={(event) => seekTo(Number(event.target.value))}
          step={FRAME_SEEK_STEP_SECONDS}
          type="range"
          value={Math.min(currentTime, duration)}
        />
        <button
          disabled={isDownloading}
          onClick={() => void downloadFrame()}
          type="button"
        >
          {isDownloading ? 'Preparing image…' : 'Download image'}
        </button>
        {error && <p className="video-frame-error">{error}</p>}
      </div>
    </div>
  );
}
