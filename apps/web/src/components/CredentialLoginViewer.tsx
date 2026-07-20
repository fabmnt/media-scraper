import { useCallback, useEffect, useRef } from 'react';
import type {
  CredentialLoginSession,
  LoginStreamClientMessage,
  Platform,
} from '@media-scraper/shared';

const SPECIAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};
const MIN_VIEWPORT_DIMENSION = 200;
const MAX_VIEWPORT_DIMENSION = 2_000;

interface FrameMetadata {
  deviceHeight: number;
  deviceWidth: number;
}

interface CredentialLoginViewerProps {
  onStreamEnded: () => void;
  platform: Platform;
  session: CredentialLoginSession;
}

function clampViewportDimension(value: number) {
  return Math.min(
    Math.max(Math.round(value), MIN_VIEWPORT_DIMENSION),
    MAX_VIEWPORT_DIMENSION,
  );
}

export function CredentialLoginViewer({
  onStreamEnded,
  platform,
  session,
}: CredentialLoginViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLImageElement>(null);
  const keyboardRef = useRef<HTMLInputElement>(null);
  const metadataRef = useRef<FrameMetadata | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);

  const send = useCallback((message: LoginStreamClientMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/api/credentials/${platform}/login-sessions/${session.id}/stream`,
    );
    socketRef.current = socket;

    const sendViewport = () => {
      const container = containerRef.current;
      if (!container || socket.readyState !== WebSocket.OPEN) return;
      const rect = container.getBoundingClientRect();
      send({
        type: 'viewport',
        width: clampViewportDimension(rect.width),
        height: clampViewportDimension(rect.height),
        deviceScaleFactor: 1,
        mobile: window.matchMedia('(pointer: coarse)').matches,
      });
    };

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as {
        data?: string;
        metadata?: FrameMetadata;
        type: string;
      };
      if (message.type === 'frame' && message.data && message.metadata) {
        metadataRef.current = message.metadata;
        const frame = frameRef.current;
        if (frame) frame.src = `data:image/jpeg;base64,${message.data}`;
        return;
      }
      if (message.type === 'ready') {
        sendViewport();
        return;
      }
      if (message.type === 'ended' && !cancelled) onStreamEnded();
    });
    socket.addEventListener('close', () => {
      if (!cancelled) onStreamEnded();
    });

    const resizeObserver = new ResizeObserver(sendViewport);
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      socket.close();
      socketRef.current = undefined;
    };
  }, [onStreamEnded, platform, send, session.id]);

  function pageCoordinates(clientX: number, clientY: number) {
    const frame = frameRef.current;
    const metadata = metadataRef.current;
    if (!frame || !metadata) return undefined;

    const rect = frame.getBoundingClientRect();
    const deviceAspect = metadata.deviceWidth / metadata.deviceHeight;
    let contentWidth = rect.width;
    let contentHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (rect.width / rect.height > deviceAspect) {
      contentWidth = rect.height * deviceAspect;
      offsetX = (rect.width - contentWidth) / 2;
    } else {
      contentHeight = rect.width / deviceAspect;
      offsetY = (rect.height - contentHeight) / 2;
    }

    const x =
      (clientX - rect.left - offsetX) * (metadata.deviceWidth / contentWidth);
    const y =
      (clientY - rect.top - offsetY) * (metadata.deviceHeight / contentHeight);
    if (x < 0 || y < 0 || x > metadata.deviceWidth || y > metadata.deviceHeight)
      return undefined;
    return { x: Math.round(x), y: Math.round(y) };
  }

  return (
    <div
      aria-label="Interactive sign-in page"
      className="login-viewer"
      onPointerDown={(event) => {
        event.preventDefault();
        keyboardRef.current?.focus({ preventScroll: true });
        const point = pageCoordinates(event.clientX, event.clientY);
        if (!point) return;
        send({
          type: 'mouse',
          mouseType: 'mousePressed',
          ...point,
          button: 'left',
          clickCount: 1,
        });
        send({
          type: 'mouse',
          mouseType: 'mouseReleased',
          ...point,
          button: 'left',
          clickCount: 1,
        });
      }}
      onWheel={(event) => {
        const point = pageCoordinates(event.clientX, event.clientY);
        if (!point) return;
        send({
          type: 'wheel',
          ...point,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        });
      }}
      ref={containerRef}
      role="application"
    >
      <img
        alt="Sign-in page stream"
        className="login-viewer-frame"
        draggable={false}
        ref={frameRef}
      />
      <input
        aria-hidden
        autoComplete="off"
        className="login-viewer-keyboard"
        onInput={(event) => {
          const input = event.currentTarget;
          if (input.value) {
            send({ type: 'insertText', text: input.value });
            input.value = '';
          }
        }}
        onKeyDown={(event) => {
          const windowsVirtualKeyCode = SPECIAL_KEY_CODES[event.key];
          if (windowsVirtualKeyCode !== undefined) {
            event.preventDefault();
            send({
              type: 'key',
              key: event.key,
              code: event.code,
              windowsVirtualKeyCode,
            });
          }
        }}
        ref={keyboardRef}
        tabIndex={-1}
      />
    </div>
  );
}
