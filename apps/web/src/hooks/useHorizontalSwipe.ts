import { useRef } from 'react';

const MIN_SWIPE_DISTANCE_PX = 50;

type UseHorizontalSwipeInput = {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
};

export function useHorizontalSwipe({
  onSwipeLeft,
  onSwipeRight,
}: UseHorizontalSwipeInput) {
  const swipeStartX = useRef<number | undefined>(undefined);
  const didSwipe = useRef(false);

  function handleTouchStart(touchX: number | undefined) {
    swipeStartX.current = touchX;
  }

  function handleTouchEnd(touchX: number | undefined) {
    const initialTouchX = swipeStartX.current;
    swipeStartX.current = undefined;
    if (initialTouchX === undefined || touchX === undefined) return;

    const swipeDistance = touchX - initialTouchX;
    if (Math.abs(swipeDistance) < MIN_SWIPE_DISTANCE_PX) return;

    didSwipe.current = true;
    if (swipeDistance > 0) onSwipeRight();
    else onSwipeLeft();
  }

  function consumeSwipe() {
    const didSwipeOccur = didSwipe.current;
    didSwipe.current = false;
    return didSwipeOccur;
  }

  return { consumeSwipe, handleTouchEnd, handleTouchStart };
}
