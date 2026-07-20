const VIDEO_VOLUME_STORAGE_KEY = 'media-scraper:video-volume';

const DEFAULT_VIDEO_VOLUME: VideoVolumeState = {
  muted: true,
  volume: 1,
};

type VideoVolumeState = {
  muted: boolean;
  volume: number;
};

const listeners = new Set<(volume: VideoVolumeState) => void>();
let currentVolume = loadStoredVolume();

function clampVolume(volume: number) {
  return Math.min(1, Math.max(0, volume));
}

function loadStoredVolume(): VideoVolumeState {
  try {
    const stored = window.localStorage.getItem(VIDEO_VOLUME_STORAGE_KEY);
    if (!stored) return DEFAULT_VIDEO_VOLUME;
    const parsed = JSON.parse(stored) as Partial<VideoVolumeState> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_VIDEO_VOLUME;
    const { muted, volume } = parsed;
    if (typeof muted !== 'boolean') return DEFAULT_VIDEO_VOLUME;
    if (typeof volume !== 'number' || !Number.isFinite(volume)) {
      return DEFAULT_VIDEO_VOLUME;
    }
    return { muted, volume: clampVolume(volume) };
  } catch {
    return DEFAULT_VIDEO_VOLUME;
  }
}

function persistVolume(volume: VideoVolumeState) {
  try {
    window.localStorage.setItem(
      VIDEO_VOLUME_STORAGE_KEY,
      JSON.stringify(volume),
    );
  } catch {
    // Storage can be unavailable; in-memory sync across videos still works.
  }
}

function applyVolume(video: HTMLVideoElement, volume: VideoVolumeState) {
  if (video.muted !== volume.muted) video.muted = volume.muted;
  if (video.volume !== volume.volume) video.volume = volume.volume;
}

export function bindVideoVolume(video: HTMLVideoElement) {
  applyVolume(video, currentVolume);

  function handleVolumeChange() {
    const nextVolume = { muted: video.muted, volume: video.volume };
    if (
      nextVolume.muted === currentVolume.muted &&
      nextVolume.volume === currentVolume.volume
    ) {
      return;
    }
    currentVolume = nextVolume;
    persistVolume(nextVolume);
    for (const listener of listeners) listener(nextVolume);
  }

  function syncVolume(volume: VideoVolumeState) {
    applyVolume(video, volume);
  }

  video.addEventListener('volumechange', handleVolumeChange);
  listeners.add(syncVolume);

  return () => {
    video.removeEventListener('volumechange', handleVolumeChange);
    listeners.delete(syncVolume);
  };
}
