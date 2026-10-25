export type CommerceReadinessStatus = {
  ready: boolean;
  storage: 'ready' | 'unavailable' | 'unknown';
  detail?: string;
};

export type CommerceReadinessResult =
  | { ready: true }
  | { ready: false; reason: string };

export type CommerceReadinessController = {
  check(assetPath?: string): Promise<CommerceReadinessResult>;
  status(): CommerceReadinessStatus;
};

export function createCommerceReadinessController(options: {
  clock: () => number;
  catalogAuthoritative: () => boolean;
  verifyWriteCapability: () => Promise<void>;
  verifyAssetReadable: (pathname: string) => Promise<void>;
  successTtlMs?: number;
  failureTtlMs?: number;
  logError?: (message: string) => void;
}): CommerceReadinessController {
  const successTtlMs = options.successTtlMs ?? 15_000;
  const failureTtlMs = options.failureTtlMs ?? 30_000;
  const cache = new Map<string, { result: CommerceReadinessResult; expiresAt: number }>();
  const inFlight = new Map<string, Promise<CommerceReadinessResult>>();
  let current: CommerceReadinessStatus = {
    ready: false,
    storage: 'unknown',
    detail: 'Authoritative storage write capability has not been verified.',
  };

  return {
    async check(assetPath) {
      if (!options.catalogAuthoritative()) {
        current = {
          ready: false,
          storage: 'unavailable',
          detail: 'Authoritative catalog storage is unavailable.',
        };
        return {
          ready: false,
          reason: 'Authoritative storage is unavailable; settlement is disabled.',
        };
      }

      const key = assetPath ?? 'commerce';
      const cached = cache.get(key);
      if (cached && cached.expiresAt > options.clock()) return cached.result;
      const existingCheck = inFlight.get(key);
      if (existingCheck) return existingCheck;

      const check = (async (): Promise<CommerceReadinessResult> => {
        try {
          if (assetPath) await options.verifyAssetReadable(assetPath);
          await options.verifyWriteCapability();
          const result = { ready: true as const };
          cache.set(key, { result, expiresAt: options.clock() + successTtlMs });
          current = { ready: true, storage: 'ready' };
          return result;
        } catch (error) {
          options.logError?.(
            `Commerce storage readiness verification failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          const result = {
            ready: false as const,
            reason: 'Authoritative storage could not establish read/write readiness.',
          };
          cache.set(key, { result, expiresAt: options.clock() + failureTtlMs });
          current = {
            ready: false,
            storage: 'unavailable',
            detail: 'Authoritative storage read/write readiness verification failed.',
          };
          return result;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, check);
      return check;
    },
    status() {
      return { ...current };
    },
  };
}
