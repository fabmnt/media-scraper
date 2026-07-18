interface PendingDiscovery {
  cancel: () => void;
  start: () => void;
}

export class ProfileDiscoveryBusyError extends Error {
  override readonly name = 'ProfileDiscoveryBusyError';
}

export class ProfileDiscoveryLimiter {
  private activeDiscoveries = 0;
  private readonly pendingDiscoveries: PendingDiscovery[] = [];

  constructor(
    private readonly maxActiveDiscoveries: number,
    private readonly maxQueuedDiscoveries: number,
  ) {}

  async run<T>(signal: AbortSignal, operation: () => Promise<T>) {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.activeDiscoveries < this.maxActiveDiscoveries) {
      this.activeDiscoveries += 1;
      return Promise.resolve(() => this.release());
    }
    if (this.pendingDiscoveries.length >= this.maxQueuedDiscoveries) {
      throw new ProfileDiscoveryBusyError(
        'Profile discovery is busy. Try again shortly.',
      );
    }

    return new Promise((resolve, reject) => {
      const pending: PendingDiscovery = {
        cancel: () => {
          const index = this.pendingDiscoveries.indexOf(pending);
          if (index >= 0) this.pendingDiscoveries.splice(index, 1);
          signal.removeEventListener('abort', pending.cancel);
          reject(signal.reason);
        },
        start: () => {
          signal.removeEventListener('abort', pending.cancel);
          this.activeDiscoveries += 1;
          resolve(() => this.release());
        },
      };
      this.pendingDiscoveries.push(pending);
      signal.addEventListener('abort', pending.cancel, { once: true });
    });
  }

  private release() {
    this.activeDiscoveries -= 1;
    this.pendingDiscoveries.shift()?.start();
  }
}
