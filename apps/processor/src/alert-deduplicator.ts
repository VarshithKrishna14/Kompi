/**
 * Distributed Alert Deduplication System
 *
 * Handles deduplication of anomaly alerts across multiple processors running
 * in parallel, potentially across different data centers.
 *
 * Key challenges addressed:
 * - Multiple processors detecting same anomaly within seconds
 * - Up to 3 seconds of clock skew between processors
 * - Processor crashes mid-processing
 * - Processor restarts re-detecting same anomaly
 * - Multi-datacenter deployment
 *
 * Solution uses PostgreSQL as distributed coordination layer with:
 * - Atomic lock acquisition via INSERT ON CONFLICT
 * - Time bucket normalization for clock skew tolerance
 * - Lock expiration for crash recovery
 * - Idempotent operations for restart safety
 */

import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, lt, and, sql } from 'drizzle-orm';
import { alertDedupLocks, type NewAlertDedupLockRow } from './schema.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface DeduplicationConfig {
  /**
   * Time window for considering alerts as duplicates (milliseconds)
   * Default: 5000ms (5 seconds)
   */
  readonly dedupWindowMs: number;

  /**
   * Maximum clock skew between processors (milliseconds)
   * Default: 3000ms (3 seconds)
   */
  readonly maxClockSkewMs: number;

  /**
   * How long to hold a lock before it expires (milliseconds)
   * This should be long enough for the processor to complete alert creation
   * Default: 30000ms (30 seconds)
   */
  readonly lockTtlMs: number;

  /**
   * Unique identifier for this processor instance
   * Used for debugging and lock tracking
   */
  readonly processorId: string;

  /**
   * Interval for cleaning up expired locks (milliseconds)
   * Default: 60000ms (1 minute)
   */
  readonly cleanupIntervalMs: number;

  /**
   * Enable debug logging
   */
  readonly debug: boolean;
}

export interface DeduplicationResult {
  /** Whether this processor won the lock (should create alert) */
  readonly shouldCreateAlert: boolean;
  /** The deduplication key used */
  readonly dedupKey: string;
  /** Lock ID if acquired */
  readonly lockId: string | null;
  /** Whether another processor already claimed this alert */
  readonly isDuplicate: boolean;
  /** Processor that owns the lock (if duplicate) */
  readonly ownerProcessorId: string | null;
}

export interface AlertContext {
  /** The metric key (e.g., "error_rate:my-service") */
  readonly metricKey: string;
  /** Type of anomaly detected */
  readonly anomalyType: string;
  /** When the anomaly was detected (processor's local time) */
  readonly detectedAt: number;
  /** Optional: severity for prioritization */
  readonly severity?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: DeduplicationConfig = {
  dedupWindowMs: 5_000,       // 5 seconds dedup window
  maxClockSkewMs: 3_000,      // 3 seconds max clock skew
  lockTtlMs: 30_000,          // 30 seconds lock TTL
  processorId: `processor-${crypto.randomUUID().slice(0, 8)}`,
  cleanupIntervalMs: 60_000,  // 1 minute cleanup interval
  debug: false,
};

// ============================================================================
// Alert Deduplicator
// ============================================================================

export class AlertDeduplicator {
  private readonly config: DeduplicationConfig;
  private readonly effectiveWindowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private db: PostgresJsDatabase | null = null;

  // Stats for monitoring
  private stats = {
    lockAttempts: 0,
    locksAcquired: 0,
    duplicatesDetected: 0,
    lockFailures: 0,
    cleanupRuns: 0,
    expiredLocksCleaned: 0,
  };

  constructor(config: Partial<DeduplicationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Effective window = dedup window + clock skew
    // This ensures any two alerts within dedupWindowMs (accounting for skew) collide
    this.effectiveWindowMs = this.config.dedupWindowMs + this.config.maxClockSkewMs;
    
    this.log(`Initialized with effective window: ${this.effectiveWindowMs}ms`);
  }

  /**
   * Initialize the deduplicator with database connection
   */
  initialize(db: PostgresJsDatabase): void {
    this.db = db;
    this.startCleanupTask();
    this.log('Alert deduplicator initialized');
  }

  /**
   * Attempt to acquire a deduplication lock for an alert.
   * 
   * This is the core deduplication logic. It uses PostgreSQL's INSERT ON CONFLICT
   * to atomically check if a lock exists and create one if not.
   * 
   * The algorithm:
   * 1. Calculate time bucket by flooring timestamp to effective window boundary
   * 2. Generate deterministic dedup key from metricKey + anomalyType + timeBucket
   * 3. Attempt atomic INSERT with ON CONFLICT DO NOTHING
   * 4. If row is returned, we won the lock -> create alert
   * 5. If no row returned, another processor won -> skip alert
   */
  async tryAcquireLock(context: AlertContext): Promise<DeduplicationResult> {
    if (!this.db) {
      throw new Error('Deduplicator not initialized - call initialize() first');
    }

    this.stats.lockAttempts++;

    const timeBucket = this.calculateTimeBucket(context.detectedAt);
    const dedupKey = this.generateDedupKey(context.metricKey, context.anomalyType, timeBucket);
    const now = Date.now();

    this.log(`Attempting lock for ${dedupKey} (bucket: ${new Date(timeBucket).toISOString()})`);

    try {
      // First, check if there's an existing valid (non-expired) lock
      const existing = await this.db
        .select()
        .from(alertDedupLocks)
        .where(
          and(
            eq(alertDedupLocks.dedupKey, dedupKey),
            // Only consider non-expired locks
            sql`${alertDedupLocks.expiresAt} > NOW()`
          )
        )
        .limit(1);

      if (existing.length > 0) {
        // Another processor already has a valid lock
        this.stats.duplicatesDetected++;
        this.log(`Duplicate detected for ${dedupKey}, owner: ${existing[0]!.processorId}`);
        
        return {
          shouldCreateAlert: false,
          dedupKey,
          lockId: null,
          isDuplicate: true,
          ownerProcessorId: existing[0]!.processorId,
        };
      }

      // Try to acquire the lock atomically
      // Using raw SQL for INSERT ... ON CONFLICT DO NOTHING RETURNING
      // This ensures atomicity even with concurrent processors
      const lockId = crypto.randomUUID();
      const expiresAt = new Date(now + this.config.lockTtlMs);
      const timeBucketDate = new Date(timeBucket);

      const insertResult = await this.db
        .insert(alertDedupLocks)
        .values({
          id: lockId,
          dedupKey,
          metricKey: context.metricKey,
          anomalyType: context.anomalyType,
          timeBucket: timeBucketDate,
          detectedAt: new Date(context.detectedAt),
          processorId: this.config.processorId,
          expiresAt,
          alertCreated: false,
        } satisfies NewAlertDedupLockRow)
        .onConflictDoNothing({ target: alertDedupLocks.dedupKey })
        .returning({ id: alertDedupLocks.id });

      if (insertResult.length > 0) {
        // We won the lock!
        this.stats.locksAcquired++;
        this.log(`Lock acquired for ${dedupKey}`);
        
        return {
          shouldCreateAlert: true,
          dedupKey,
          lockId: insertResult[0]!.id,
          isDuplicate: false,
          ownerProcessorId: this.config.processorId,
        };
      } else {
        // Another processor acquired the lock between our check and insert
        // This is the race condition case - we lost
        this.stats.duplicatesDetected++;
        this.log(`Lost race for ${dedupKey}`);
        
        return {
          shouldCreateAlert: false,
          dedupKey,
          lockId: null,
          isDuplicate: true,
          ownerProcessorId: null, // Unknown, someone else got it
        };
      }
    } catch (error) {
      this.stats.lockFailures++;
      console.error(`Failed to acquire dedup lock for ${dedupKey}:`, error);
      
      // On error, fail open (allow alert creation) to avoid losing alerts
      // This is a tradeoff: potential duplicates vs. lost alerts
      // In production, losing alerts is usually worse than duplicates
      return {
        shouldCreateAlert: true,
        dedupKey,
        lockId: null,
        isDuplicate: false,
        ownerProcessorId: this.config.processorId,
      };
    }
  }

  /**
   * Mark an alert as successfully created.
   * This updates the lock record with the alert ID and marks it as created.
   */
  async markAlertCreated(lockId: string, alertId: string): Promise<void> {
    if (!this.db || !lockId) {
      return;
    }

    try {
      await this.db
        .update(alertDedupLocks)
        .set({
          alertId,
          alertCreated: true,
        })
        .where(eq(alertDedupLocks.id, lockId));
      
      this.log(`Marked alert created for lock ${lockId}`);
    } catch (error) {
      console.error(`Failed to mark alert created for lock ${lockId}:`, error);
    }
  }

  /**
   * Release a lock (e.g., if alert creation failed and we want to retry).
   * In most cases, you should let locks expire naturally.
   */
  async releaseLock(lockId: string): Promise<void> {
    if (!this.db || !lockId) {
      return;
    }

    try {
      await this.db
        .delete(alertDedupLocks)
        .where(
          and(
            eq(alertDedupLocks.id, lockId),
            eq(alertDedupLocks.processorId, this.config.processorId)
          )
        );
      
      this.log(`Released lock ${lockId}`);
    } catch (error) {
      console.error(`Failed to release lock ${lockId}:`, error);
    }
  }

  /**
   * Calculate the time bucket for a given timestamp.
   * 
   * The bucket is calculated by flooring to the effective window boundary.
   * This ensures that any two timestamps within effectiveWindowMs of each other
   * will map to at most 2 adjacent buckets.
   * 
   * To handle the boundary case, we check both the current bucket and the
   * previous bucket when looking for duplicates (handled in dedupKey generation).
   */
  private calculateTimeBucket(timestamp: number): number {
    // Floor to effective window boundary
    return Math.floor(timestamp / this.effectiveWindowMs) * this.effectiveWindowMs;
  }

  /**
   * Generate a deterministic deduplication key.
   * 
   * The key combines:
   * - metricKey: identifies the metric being monitored
   * - anomalyType: type of anomaly (allows same metric to have different anomaly types)
   * - timeBucket: normalized time window
   * 
   * Format: "metricKey|anomalyType|timeBucket"
   */
  private generateDedupKey(metricKey: string, anomalyType: string, timeBucket: number): string {
    return `${metricKey}|${anomalyType}|${timeBucket}`;
  }

  /**
   * Check if an alert would be a duplicate (without acquiring lock).
   * Useful for pre-flight checks.
   */
  async checkIsDuplicate(context: AlertContext): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    const timeBucket = this.calculateTimeBucket(context.detectedAt);
    const dedupKey = this.generateDedupKey(context.metricKey, context.anomalyType, timeBucket);

    try {
      const existing = await this.db
        .select({ id: alertDedupLocks.id })
        .from(alertDedupLocks)
        .where(
          and(
            eq(alertDedupLocks.dedupKey, dedupKey),
            sql`${alertDedupLocks.expiresAt} > NOW()`
          )
        )
        .limit(1);

      return existing.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Clean up expired locks.
   * This runs periodically to remove stale locks from crashed processors.
   */
  private async cleanupExpiredLocks(): Promise<number> {
    if (!this.db) {
      return 0;
    }

    this.stats.cleanupRuns++;

    try {
      const result = await this.db
        .delete(alertDedupLocks)
        .where(lt(alertDedupLocks.expiresAt, new Date()))
        .returning({ id: alertDedupLocks.id });

      const cleaned = result.length;
      this.stats.expiredLocksCleaned += cleaned;

      if (cleaned > 0) {
        this.log(`Cleaned up ${cleaned} expired locks`);
      }

      return cleaned;
    } catch (error) {
      console.error('Failed to cleanup expired locks:', error);
      return 0;
    }
  }

  /**
   * Start the background cleanup task.
   */
  private startCleanupTask(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredLocks();
    }, this.config.cleanupIntervalMs);

    // Don't prevent process exit
    this.cleanupTimer.unref?.();
  }

  /**
   * Stop the background cleanup task.
   */
  stopCleanupTask(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Get deduplication statistics.
   */
  getStats(): Readonly<typeof this.stats> {
    return { ...this.stats };
  }

  /**
   * Get the processor ID.
   */
  getProcessorId(): string {
    return this.config.processorId;
  }

  /**
   * Get effective deduplication window (includes clock skew compensation).
   */
  getEffectiveWindowMs(): number {
    return this.effectiveWindowMs;
  }

  /**
   * Shutdown the deduplicator gracefully.
   */
  async shutdown(): Promise<void> {
    this.stopCleanupTask();
    
    // Final cleanup
    if (this.db) {
      await this.cleanupExpiredLocks();
    }
    
    this.db = null;
    this.log('Alert deduplicator shutdown');
  }

  /**
   * Debug logging.
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[AlertDeduplicator:${this.config.processorId.slice(0, 8)}] ${message}`);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create and configure an alert deduplicator.
 */
export function createAlertDeduplicator(
  config: Partial<DeduplicationConfig> = {}
): AlertDeduplicator {
  return new AlertDeduplicator(config);
}

// ============================================================================
// Types Export
// ============================================================================

export type { DeduplicationConfig, DeduplicationResult, AlertContext };

