// Log processing entrypoint integrating the statistical AnomalyDetector.
// This is a minimal example; adapt wiring to your actual ingestion pipeline.

import { AnomalyDetector, AnomalyPoint } from "./anomaly-detector";

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
 * Process a batch of logs and return anomaly detection result.
 * This function is synchronous and designed for low latency.
 */
export function processLogBatch(logs: LogRecord[]) {
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


