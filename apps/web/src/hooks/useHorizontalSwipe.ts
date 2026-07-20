import { useRef } from 'react';

const MIN_SWIPE_DISTANCE_PX = 50;

type TouchCoordinates = {
  clientX: number;
  clientY: number;
};

type UseHorizontalSwipeInput = {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
};

export function useHorizontalSwipe({
  onSwipeLeft,
  onSwipeRight,
}: UseHorizontalSwipeInput) {
  const swipeStart = useRef<TouchCoordinates | undefined>(undefined);
  const didSwipe = useRef(false);

  function handleTouchStart(touch: TouchCoordinates | undefined) {
    didSwipe.current = false;
    swipeStart.current = touch;
  }

  function handleTouchEnd(touch: TouchCoordinates | undefined) {
    const initialTouch = swipeStart.current;
    swipeStart.current = undefined;
    if (!initialTouch || !touch) return;

    const horizontalDistance = touch.clientX - initialTouch.clientX;
    const verticalDistance = touch.clientY - initialTouch.clientY;
    if (
      Math.abs(horizontalDistance) < MIN_SWIPE_DISTANCE_PX ||
      Math.abs(horizontalDistance) <= Math.abs(verticalDistance)
    ) {
      return;
    }

    didSwipe.current = true;
    if (horizontalDistance > 0) onSwipeRight();
    else onSwipeLeft();
  }

  function consumeSwipe() {
    const didSwipeOccur = didSwipe.current;
    didSwipe.current = false;
    return didSwipeOccur;
  }

  return { consumeSwipe, handleTouchEnd, handleTouchStart };
}
