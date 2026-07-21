import { type UIEvent, useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_OVERSCAN = 4;

export function useVirtualList({
  itemCount,
  itemHeight,
  overscan = DEFAULT_OVERSCAN,
}: {
  itemCount: number;
  itemHeight: number;
  overscan?: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const observer = new ResizeObserver((entries) => {
      setViewportHeight(entries[0]!.contentRect.height);
    });
    observer.observe(list);
    setViewportHeight(list.clientHeight);

    return () => observer.disconnect();
  }, []);

  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(
    itemCount,
    Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan,
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      const list = listRef.current;
      if (!list) return;

      const itemTop = index * itemHeight;
      const itemBottom = itemTop + itemHeight;
      if (itemTop < list.scrollTop) {
        list.scrollTop = itemTop;
      } else if (itemBottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = itemBottom - list.clientHeight;
      }
    },
    [itemHeight],
  );

  return {
    endIndex,
    listRef,
    onScroll: (event: UIEvent<HTMLDivElement>) =>
      setScrollTop(event.currentTarget.scrollTop),
    scrollToIndex,
    startIndex,
    totalHeight: itemCount * itemHeight,
  };
}
