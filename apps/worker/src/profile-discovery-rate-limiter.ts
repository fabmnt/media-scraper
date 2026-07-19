// This gate is shared by both profile queues in one worker process. Run one
// worker replica when upstream profile-discovery pacing must be globally strict.
let nextProfileDiscoveryAt = 0;
let pendingProfileDiscovery = Promise.resolve();

function waitForDelay(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
    timeout.unref();
  });
}

export function waitForProfileDiscovery(
  intervalMs: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const next = pendingProfileDiscovery.then(async () => {
    const delayMs = Math.max(0, nextProfileDiscoveryAt - Date.now());
    if (delayMs > 0) await waitForDelay(delayMs, signal);
    nextProfileDiscoveryAt = Date.now() + intervalMs;
  });
  pendingProfileDiscovery = next.catch(() => undefined);
  return next;
}
