// Distributed alert deduplication utilities.
// The goal is to prevent duplicate alerts when multiple processors running
// in parallel detect the same anomaly within a short time window.
//
// This module is intentionally storage-agnostic: in production you should
// back it with a distributed key-value store that supports atomic
// "set-if-not-exists with TTL" semantics (e.g. Redis SET NX PX).

export interface AlertDeduplicator {
  /**
   * Returns true if this processor should emit an alert for the given
   * fingerprint, considering the deduplication window.
   *
   * Returns false if an equivalent alert has already been emitted by any
   * processor within the deduplication window.
   *
   * Implementations MUST be safe under concurrent calls from multiple
   * processes and machines and SHOULD use a shared, strongly-consistent
   * store for correctness.
   */
  shouldEmit(fingerprint: string, dedupWindowMs: number): Promise<boolean>;
}

/**
 * Generic minimal key-value API needed for distributed dedup.
 *
 * In production, implement this using:
 * - Redis: SET key value NX PX ttlMs   (resolve true if "OK", false otherwise)
 * - DynamoDB / SQL: conditional insert with TTL column and unique constraint
 */
export interface DedupKeyValueStore {
  /**
   * Atomically set the given key with a TTL if it does not already exist.
   *
   * @returns true if the key was created (caller "wins" and should emit),
   *          false if the key already existed (duplicate alert).
   */
  setIfNotExistsWithTTL(
    key: string,
    ttlMs: number,
  ): Promise<boolean>;
}

/**
 * AlertDeduplicator implementation that delegates to a generic key-value store.
 */
export class KeyValueStoreAlertDeduplicator implements AlertDeduplicator {
  private readonly store: DedupKeyValueStore;
  private readonly keyPrefix: string;

  constructor(store: DedupKeyValueStore, keyPrefix = "alert_dedup:") {
    this.store = store;
    this.keyPrefix = keyPrefix.endsWith(":") ? keyPrefix : `${keyPrefix}:`;
  }

  async shouldEmit(fingerprint: string, dedupWindowMs: number): Promise<boolean> {
    const ttl = Math.max(1, Math.floor(dedupWindowMs));
    const key = `${this.keyPrefix}${fingerprint}`;
    return this.store.setIfNotExistsWithTTL(key, ttl);
  }
}

/**
 * In-memory DedupKeyValueStore useful for local development or unit tests.
 * NOTE: This is NOT distributed; do not use it in production deployments.
 */
export class InMemoryDedupKeyValueStore implements DedupKeyValueStore {
  private readonly data = new Map<string, number>(); // key -> expiry timestamp (ms)

  async setIfNotExistsWithTTL(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const existingExpiry = this.data.get(key);

    if (existingExpiry !== undefined && existingExpiry > now) {
      // Key is still valid -> duplicate.
      return false;
    }

    const expiry = now + Math.max(1, Math.floor(ttlMs));
    this.data.set(key, expiry);
    return true;
  }
}


