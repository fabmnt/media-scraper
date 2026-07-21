import { useEffect, useRef, useState } from 'react';

const VIEWPORT_ROOT_MARGIN = '600px 0px';

const visibilityCallbacks = new Map<Element, (isVisible: boolean) => void>();
let observer: IntersectionObserver | undefined;

function getObserver() {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        visibilityCallbacks.get(entry.target)?.(entry.isIntersecting);
      }
    },
    { rootMargin: VIEWPORT_ROOT_MARGIN },
  );

  return observer;
}

export function useViewportVisibility<T extends Element>() {
  const targetRef = useRef<T>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    if (!('IntersectionObserver' in window)) {
      setIsVisible(true);
      return;
    }

    const activeObserver = getObserver();
    visibilityCallbacks.set(target, (visible) => {
      setIsVisible((current) => (current === visible ? current : visible));
    });
    activeObserver.observe(target);

    return () => {
      activeObserver.unobserve(target);
      visibilityCallbacks.delete(target);
      if (visibilityCallbacks.size === 0) {
        activeObserver.disconnect();
        observer = undefined;
      }
    };
  }, []);

  return { isVisible, targetRef };
}
