// Log processing entrypoint integrating the statistical AnomalyDetector.
// This is a minimal example; adapt wiring to your actual ingestion pipeline.

import { createHash } from "crypto";
import { AnomalyDetector, AnomalyPoint } from "./anomaly-detecter";
import {
  AlertDeduplicator,
  InMemoryDedupKeyValueStore,
  KeyValueStoreAlertDeduplicator,
} from "./alert-dedup";

// You can tune these config values per-service or per-endpoint as needed.
const detector = new AnomalyDetector({
  ewmaAlpha: 0.1,
  minSamplesForZScore: 30,
  zScoreThreshold: 3.0,
  spikeWindowMs: 60_000,
  spikeFactorThreshold: 5,
  minWindowTotalCount: 200,
});

export interface LogRecord {
  timestamp: number; // Unix ms
  level: "debug" | "info" | "warn" | "error" | "fatal";
  service: string;
  message: string;
}

export interface LogBatchProcessResult {
  isAnomaly: boolean;
  reason?: string;
  detection?: ReturnType<AnomalyDetector["detect"]>;
}

export interface DedupAwareProcessResult extends LogBatchProcessResult {
  /**
   * True if this processor should actually emit an alert for the anomaly,
   * after considering distributed deduplication.
   */
  shouldEmitAlert: boolean;
  /**
   * Stable fingerprint for the anomaly; can be used as an idempotency key
   * downstream (e.g. in databases or alerting systems).
   */
  fingerprint?: string;
}

/**
 * Aggregate logs into a single AnomalyPoint.
 * In a real system you would likely:
 * - Aggregate per (service, route, statusCode) key
 * - Use a fixed bucket width (e.g. 1 second)
 */
function aggregateLogsToPoint(logs: LogRecord[]): AnomalyPoint | null {
  if (logs.length === 0) {
    return null;
  }
  let errorCount = 0;
  let minTs = Infinity;
  for (const log of logs) {
    if (log.level === "error" || log.level === "fatal") {
      errorCount += 1;
    }
    if (Number.isFinite(log.timestamp) && log.timestamp < minTs) {
      minTs = log.timestamp;
    }
  }
  const totalCount = logs.length;
  const timestamp = Number.isFinite(minTs) ? minTs : Date.now();

  return { timestamp, errorCount, totalCount };
}

/**
 * Compute a deterministic fingerprint for an anomaly based on detector id and
 * the log batch's keying dimensions. This MUST be stable across processors and
 * runs: the same logical anomaly must yield the same fingerprint string.
 */
export function computeAlertFingerprint(logs: LogRecord[]): string {
  const first = logs[0];
  const service = first?.service ?? "unknown";

  const detectorId = "error_rate_anomaly_v1";
  const logicalKey = `${detectorId}|service=${service}`;

  const hash = createHash("sha256");
  hash.update(logicalKey);
  return hash.digest("hex");
}

/**
 * Process a batch of logs and return anomaly detection result.
 * This function is synchronous and designed for low latency.
 */
export function processLogBatch(logs: LogRecord[]): LogBatchProcessResult {
  const point = aggregateLogsToPoint(logs);
  if (!point) {
    return {
      isAnomaly: false,
      reason: "empty_batch",
    };
  }

  const detection = detector.detect(point);

  // In production, you might:
  // - Persist anomalies to PostgreSQL via Drizzle ORM
  // - Emit metrics to your observability stack
  // - Trigger alerts when detection.isAnomaly is true

  return {
    isAnomaly: detection.isAnomaly,
    detection,
  };
}

/**
 * Create a process-wide default deduplicator suitable for local development or
 * single-process deployments. In production you should construct a
 * KeyValueStoreAlertDeduplicator backed by a distributed store (e.g. Redis).
 */
export function createDefaultDeduplicator(): AlertDeduplicator {
  const store = new InMemoryDedupKeyValueStore();
  return new KeyValueStoreAlertDeduplicator(store);
}

/**
 * Dedup-aware variant of processLogBatch. It computes an anomaly fingerprint
 * and consults a distributed AlertDeduplicator to decide whether this
 * processor should actually emit an alert.
 *
 * This function is async because real distributed stores (Redis, SQL, etc.)
 * require network I/O.
 */
export async function processLogBatchWithDedup(
  logs: LogRecord[],
  options: {
    deduplicator: AlertDeduplicator;
    /**
     * Deduplication window in milliseconds. Alerts for the same fingerprint
     * within this window will be suppressed across all processors that share
     * the same backing store.
     */
    dedupWindowMs?: number;
  },
): Promise<DedupAwareProcessResult> {
  const base = processLogBatch(logs);

  if (!base.isAnomaly) {
    return {
      ...base,
      shouldEmitAlert: false,
    };
  }

  const fingerprint = computeAlertFingerprint(logs);
  const dedupWindowMs = options.dedupWindowMs ?? 5_000;

  let shouldEmitAlert = true;
  try {
    shouldEmitAlert = await options.deduplicator.shouldEmit(
      fingerprint,
      dedupWindowMs,
    );
  } catch {
    // Fail-open: if the dedup store is unavailable, we still emit the alert
    // to avoid silently dropping important signals.
    shouldEmitAlert = true;
  }

  return {
    ...base,
    shouldEmitAlert,
    fingerprint,
  };
}
