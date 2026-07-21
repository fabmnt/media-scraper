import {
  type ReactEventHandler,
  type TouchEventHandler,
  useState,
} from 'react';
import { useVideoVolume } from '../hooks/useVideoVolume';

const FRAME_IMAGE_MIME_TYPE = 'image/jpeg';
const FRAME_IMAGE_QUALITY = 0.92;
const FRAME_SEEK_STEP_SECONDS = 0.1;
const SEEK_TIMEOUT_MS = 10_000;
const URL_REVOKE_DELAY_MS = 0;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;

type VideoFrameCaptureProps = {
  fileName: string;
  onError?: ReactEventHandler<HTMLVideoElement>;
  onLoadedData?: ReactEventHandler<HTMLVideoElement>;
  onTouchEnd?: TouchEventHandler<HTMLVideoElement>;
  onTouchStart?: TouchEventHandler<HTMLVideoElement>;
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
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('error', handleFailure);
      video.removeEventListener('abort', handleFailure);
    };
    const handleSeeked = () => {
      cleanup();
      resolve();
    };
    const handleFailure = () => {
      cleanup();
      reject(new Error('The video could not seek to the selected moment.'));
    };
    const timeout = window.setTimeout(handleFailure, SEEK_TIMEOUT_MS);

    video.addEventListener('seeked', handleSeeked);
    video.addEventListener('error', handleFailure);
    video.addEventListener('abort', handleFailure);
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
  window.setTimeout(
    () => URL.revokeObjectURL(downloadUrl),
    URL_REVOKE_DELAY_MS,
  );
}

export function VideoFrameCapture({
  fileName,
  onError,
  onLoadedData,
  onTouchEnd,
  onTouchStart,
  src,
}: VideoFrameCaptureProps) {
  const { bindVideo, videoRef } = useVideoVolume();
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

    const wasPlaying = !video.paused;
    video.pause();
    video.controls = false;
    const selectedTime = video.currentTime;
    setIsDownloading(true);
    setError(undefined);
    try {
      await waitForSeek(video);
      if (video.currentTime !== selectedTime) {
        throw new Error('The selected moment changed. Try downloading again.');
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        throw new Error('The video frame is not ready.');
      }
      const blob = await captureFrame(video);
      downloadBlob(blob, getFrameFileName(fileName, selectedTime));
    } catch (captureError) {
      setError(
        captureError instanceof Error
          ? captureError.message
          : 'The video frame could not be downloaded.',
      );
    } finally {
      video.controls = true;
      if (wasPlaying) void video.play().catch(() => undefined);
      setIsDownloading(false);
    }
  }

  return (
    <div className="video-frame-preview">
      <video
        aria-label="Video preview"
        crossOrigin="anonymous"
        controls
        loop
        playsInline
        onError={onError}
        onLoadedData={onLoadedData}
        onLoadedMetadata={(event) => {
          const videoDuration = event.currentTarget.duration;
          setDuration(Number.isFinite(videoDuration) ? videoDuration : 0);
          updateCurrentTime(event.currentTarget.currentTime);
        }}
        onTouchEnd={onTouchEnd}
        onTouchStart={onTouchStart}
        onTimeUpdate={(event) =>
          updateCurrentTime(event.currentTarget.currentTime)
        }
        ref={bindVideo}
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
          disabled={!duration || isDownloading}
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
