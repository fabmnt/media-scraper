import { useCallback, useRef } from 'react';
import { bindVideoVolume } from '../video-volume';

export function useVideoVolume() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const unbindVolumeRef = useRef<(() => void) | undefined>(undefined);

  const bindVideo = useCallback((video: HTMLVideoElement | null) => {
    unbindVolumeRef.current?.();
    unbindVolumeRef.current = undefined;
    videoRef.current = video;
    if (video) unbindVolumeRef.current = bindVideoVolume(video);
  }, []);

  return { bindVideo, videoRef };
}
