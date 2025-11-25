/**
 * Drizzle ORM Schema for Anomaly Detection System
 * PostgreSQL database schema for logs, baselines, and alerts
 */

import {
  pgTable,
  text,
  timestamp,
  integer,
  doublePrecision,
  jsonb,
  uuid,
  varchar,
  index,
  boolean,
} from 'drizzle-orm/pg-core';

// ============================================================================
// Log Entry Table
// ============================================================================

export const logEntries = pgTable(
  'log_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    level: varchar('level', { length: 20 }).notNull(), // 'debug', 'info', 'warn', 'error', 'fatal'
    message: text('message').notNull(),
    service: varchar('service', { length: 255 }).notNull(),
    environment: varchar('environment', { length: 50 }).notNull().default('production'),
    traceId: varchar('trace_id', { length: 64 }),
    spanId: varchar('span_id', { length: 32 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    isAnomaly: boolean('is_anomaly').notNull().default(false),
    anomalyType: varchar('anomaly_type', { length: 50 }),
    zScore: doublePrecision('z_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_log_entries_timestamp').on(table.timestamp),
    index('idx_log_entries_service').on(table.service),
    index('idx_log_entries_level').on(table.level),
    index('idx_log_entries_is_anomaly').on(table.isAnomaly),
    index('idx_log_entries_service_timestamp').on(table.service, table.timestamp),
  ]
);

export type LogEntry = typeof logEntries.$inferSelect;
export type NewLogEntry = typeof logEntries.$inferInsert;

// ============================================================================
// Error Rate Metrics Table
// ============================================================================

export const errorRateMetrics = pgTable(
  'error_rate_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metricKey: varchar('metric_key', { length: 255 }).notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    errorCount: integer('error_count').notNull().default(0),
    totalCount: integer('total_count').notNull().default(0),
    errorRate: doublePrecision('error_rate').notNull(),
    service: varchar('service', { length: 255 }).notNull(),
    environment: varchar('environment', { length: 50 }).notNull().default('production'),
  },
  (table) => [
    index('idx_error_rate_metric_key').on(table.metricKey),
    index('idx_error_rate_timestamp').on(table.timestamp),
    index('idx_error_rate_service').on(table.service),
  ]
);

export type ErrorRateMetric = typeof errorRateMetrics.$inferSelect;
export type NewErrorRateMetric = typeof errorRateMetrics.$inferInsert;

// ============================================================================
// Baseline State Table
// ============================================================================

export const baselineStates = pgTable(
  'baseline_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metricKey: varchar('metric_key', { length: 255 }).notNull().unique(),
    mean: doublePrecision('mean').notNull().default(0),
    variance: doublePrecision('variance').notNull().default(0),
    stdDev: doublePrecision('std_dev').notNull().default(0),
    ewma: doublePrecision('ewma').notNull().default(0),
    ewmaVariance: doublePrecision('ewma_variance').notNull().default(0),
    sampleCount: integer('sample_count').notNull().default(0),
    config: jsonb('config').$type<{
      zScoreThreshold: number;
      ewmaAlpha: number;
      spikeWindowMs: number;
      spikeMultiplier: number;
      minSampleCount: number;
      regimeChangeSensitivity: number;
      regimeWindowMs: number;
      maxWindowSize: number;
    }>(),
    lastUpdated: timestamp('last_updated', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_baseline_metric_key').on(table.metricKey),
    index('idx_baseline_last_updated').on(table.lastUpdated),
  ]
);

export type BaselineStateRow = typeof baselineStates.$inferSelect;
export type NewBaselineStateRow = typeof baselineStates.$inferInsert;

// ============================================================================
// Anomaly Alerts Table
// ============================================================================

export const anomalyAlerts = pgTable(
  'anomaly_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metricKey: varchar('metric_key', { length: 255 }).notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
    anomalyType: varchar('anomaly_type', { length: 50 }).notNull(),
    severity: varchar('severity', { length: 20 }).notNull(), // 'low', 'medium', 'high', 'critical'
    zScore: doublePrecision('z_score').notNull(),
    currentValue: doublePrecision('current_value').notNull(),
    ewmaValue: doublePrecision('ewma_value').notNull(),
    baselineMean: doublePrecision('baseline_mean').notNull(),
    baselineStdDev: doublePrecision('baseline_std_dev').notNull(),
    spikeRatio: doublePrecision('spike_ratio'),
    confidence: doublePrecision('confidence').notNull(),
    details: text('details').notNull(),
    acknowledged: boolean('acknowledged').notNull().default(false),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: varchar('acknowledged_by', { length: 255 }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_alerts_metric_key').on(table.metricKey),
    index('idx_alerts_timestamp').on(table.timestamp),
    index('idx_alerts_severity').on(table.severity),
    index('idx_alerts_acknowledged').on(table.acknowledged),
    index('idx_alerts_metric_timestamp').on(table.metricKey, table.timestamp),
  ]
);

export type AnomalyAlertRow = typeof anomalyAlerts.$inferSelect;
export type NewAnomalyAlertRow = typeof anomalyAlerts.$inferInsert;

// ============================================================================
// Recent Snapshots Table (for persistence across restarts)
// ============================================================================

export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metricKey: varchar('metric_key', { length: 255 }).notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    value: doublePrecision('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_snapshots_metric_key').on(table.metricKey),
    index('idx_snapshots_timestamp').on(table.timestamp),
    index('idx_snapshots_metric_timestamp').on(table.metricKey, table.timestamp),
  ]
);

export type MetricSnapshotRow = typeof metricSnapshots.$inferSelect;
export type NewMetricSnapshotRow = typeof metricSnapshots.$inferInsert;

