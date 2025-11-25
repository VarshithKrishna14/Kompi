/**
 * Statistical Anomaly Detection System
 *
 * Features:
 * - Z-score based anomaly detection
 * - Exponentially Weighted Moving Averages (EWMA)
 * - Rate-of-change spike detection (e.g., 5x increase in 60 seconds)
 * - Regime change adaptation (baseline shifts over time)
 * - High-performance design for 100k+ logs/min with <10ms latency
 * - Robust edge case handling (Infinity, NaN, zero divisions)
 */

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface AnomalyConfig {
  /** Z-score threshold for anomaly detection (default: 3.0) */
  readonly zScoreThreshold: number;
  /** EWMA smoothing factor (alpha), range 0-1, higher = more weight on recent (default: 0.3) */
  readonly ewmaAlpha: number;
  /** Time window for spike detection in milliseconds (default: 60000 = 60s) */
  readonly spikeWindowMs: number;
  /** Spike multiplier threshold (default: 5.0 = 5x increase) */
  readonly spikeMultiplier: number;
  /** Minimum sample count before detecting anomalies (default: 30) */
  readonly minSampleCount: number;
  /** Regime change detection sensitivity (default: 0.1) */
  readonly regimeChangeSensitivity: number;
  /** Time window for regime change detection in ms (default: 300000 = 5 min) */
  readonly regimeWindowMs: number;
  /** Maximum samples to keep in sliding window (default: 10000) */
  readonly maxWindowSize: number;
}

export interface MetricSnapshot {
  readonly timestamp: number;
  readonly value: number;
}

export interface AnomalyResult {
  readonly isAnomaly: boolean;
  readonly anomalyType: AnomalyType;
  readonly zScore: number;
  readonly currentValue: number;
  readonly ewmaValue: number;
  readonly baselineMean: number;
  readonly baselineStdDev: number;
  readonly spikeRatio: number | null;
  readonly confidence: number;
  readonly details: string;
}

export type AnomalyType =
  | 'none'
  | 'z_score_high'
  | 'z_score_low'
  | 'spike'
  | 'regime_change'
  | 'combined';

export interface BaselineState {
  readonly mean: number;
  readonly variance: number;
  readonly stdDev: number;
  readonly ewma: number;
  readonly ewmaVariance: number;
  readonly sampleCount: number;
  readonly lastUpdated: number;
}

export interface SerializedState {
  readonly config: AnomalyConfig;
  readonly baseline: BaselineState;
  readonly recentSnapshots: readonly MetricSnapshot[];
  readonly metricKey: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: AnomalyConfig = {
  zScoreThreshold: 3.0,
  ewmaAlpha: 0.3,
  spikeWindowMs: 60_000,
  spikeMultiplier: 5.0,
  minSampleCount: 30,
  regimeChangeSensitivity: 0.1,
  regimeWindowMs: 300_000,
  maxWindowSize: 10_000,
} as const;

const EPSILON = 1e-10;
const MAX_SAFE_VALUE = 1e15;
const MIN_SAFE_VALUE = -1e15;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Safely clamp and sanitize numeric values
 * Handles Infinity, NaN, and extreme values
 */
function sanitizeValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(MIN_SAFE_VALUE, Math.min(MAX_SAFE_VALUE, value));
}

/**
 * Safe division that handles zero denominators
 */
function safeDivide(numerator: number, denominator: number): number {
  const sanitizedNum = sanitizeValue(numerator);
  const sanitizedDenom = sanitizeValue(denominator);

  if (Math.abs(sanitizedDenom) < EPSILON) {
    return 0;
  }

  const result = sanitizedNum / sanitizedDenom;
  return sanitizeValue(result);
}

/**
 * Safe square root that handles negative values
 */
function safeStdDev(variance: number): number {
  const sanitized = sanitizeValue(variance);
  if (sanitized < 0) {
    return 0;
  }
  return Math.sqrt(sanitized);
}

/**
 * Calculate z-score with safety checks
 */
function calculateZScore(value: number, mean: number, stdDev: number): number {
  const sanitizedValue = sanitizeValue(value);
  const sanitizedMean = sanitizeValue(mean);
  const sanitizedStdDev = sanitizeValue(stdDev);

  if (sanitizedStdDev < EPSILON) {
    // If no variance, any deviation is significant
    const diff = Math.abs(sanitizedValue - sanitizedMean);
    return diff < EPSILON ? 0 : (sanitizedValue > sanitizedMean ? 10 : -10);
  }

  return safeDivide(sanitizedValue - sanitizedMean, sanitizedStdDev);
}

// ============================================================================
// Circular Buffer for High-Performance Sliding Window
// ============================================================================

class CircularBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private head: number = 0;
  private tail: number = 0;
  private count: number = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;

    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  *[Symbol.iterator](): Iterator<T> {
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) {
        yield item;
      }
    }
  }

  toArray(): T[] {
    const result: T[] = [];
    for (const item of this) {
      result.push(item);
    }
    return result;
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
    this.buffer.fill(undefined);
  }

  filter(predicate: (item: T) => boolean): T[] {
    const result: T[] = [];
    for (const item of this) {
      if (predicate(item)) {
        result.push(item);
      }
    }
    return result;
  }

  getOldest(): T | undefined {
    if (this.count === 0) return undefined;
    return this.buffer[this.head];
  }

  getNewest(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.tail - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }
}

// ============================================================================
// Anomaly Detector Class
// ============================================================================

export class AnomalyDetector {
  private readonly config: AnomalyConfig;
  private readonly metricKey: string;
  private readonly snapshots: CircularBuffer<MetricSnapshot>;

  // Baseline statistics (using Welford's online algorithm for numerical stability)
  private mean: number = 0;
  private m2: number = 0; // Sum of squared differences from mean
  private sampleCount: number = 0;

  // EWMA state
  private ewma: number = 0;
  private ewmaVariance: number = 0;
  private ewmaInitialized: boolean = false;

  // Regime detection
  private lastRegimeCheck: number = 0;
  private regimeMean: number = 0;
  private regimeSampleCount: number = 0;

  constructor(
    metricKey: string,
    config: Partial<AnomalyConfig> = {}
  ) {
    this.metricKey = metricKey;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.snapshots = new CircularBuffer<MetricSnapshot>(this.config.maxWindowSize);

    // Validate config
    this.validateConfig();
  }

  private validateConfig(): void {
    const { config } = this;

    if (config.zScoreThreshold <= 0) {
      throw new Error('zScoreThreshold must be positive');
    }
    if (config.ewmaAlpha <= 0 || config.ewmaAlpha > 1) {
      throw new Error('ewmaAlpha must be in range (0, 1]');
    }
    if (config.spikeWindowMs <= 0) {
      throw new Error('spikeWindowMs must be positive');
    }
    if (config.spikeMultiplier <= 1) {
      throw new Error('spikeMultiplier must be greater than 1');
    }
    if (config.minSampleCount < 1) {
      throw new Error('minSampleCount must be at least 1');
    }
  }

  /**
   * Process a new metric value and detect anomalies
   * Optimized for high throughput (<10ms latency)
   */
  process(value: number, timestamp: number = Date.now()): AnomalyResult {
    const sanitizedValue = sanitizeValue(value);
    const snapshot: MetricSnapshot = { timestamp, value: sanitizedValue };

    // Store snapshot
    this.snapshots.push(snapshot);

    // Update baseline using Welford's algorithm (O(1) update)
    this.updateBaseline(sanitizedValue);

    // Update EWMA (O(1) update)
    this.updateEwma(sanitizedValue);

    // Check for regime change periodically
    this.checkRegimeChange(timestamp);

    // Detect anomalies
    return this.detectAnomaly(sanitizedValue, timestamp);
  }

  /**
   * Welford's online algorithm for computing mean and variance
   * Numerically stable and O(1) per update
   */
  private updateBaseline(value: number): void {
    this.sampleCount++;
    const delta = value - this.mean;
    this.mean += delta / this.sampleCount;
    const delta2 = value - this.mean;
    this.m2 += delta * delta2;
  }

  /**
   * Update EWMA and EWMA variance
   */
  private updateEwma(value: number): void {
    const alpha = this.config.ewmaAlpha;

    if (!this.ewmaInitialized) {
      this.ewma = value;
      this.ewmaVariance = 0;
      this.ewmaInitialized = true;
      return;
    }

    const diff = value - this.ewma;
    const incr = alpha * diff;
    this.ewma += incr;
    this.ewmaVariance = (1 - alpha) * (this.ewmaVariance + alpha * diff * diff);
  }

  /**
   * Check for regime changes (baseline shifts)
   * Uses a sliding window comparison
   */
  private checkRegimeChange(timestamp: number): void {
    // Only check periodically to save computation
    if (timestamp - this.lastRegimeCheck < this.config.regimeWindowMs / 10) {
      return;
    }
    this.lastRegimeCheck = timestamp;

    const windowStart = timestamp - this.config.regimeWindowMs;
    const recentSnapshots = this.snapshots.filter(s => s.timestamp >= windowStart);

    if (recentSnapshots.length < this.config.minSampleCount) {
      return;
    }

    // Calculate recent window mean
    let sum = 0;
    for (const s of recentSnapshots) {
      sum += s.value;
    }
    const recentMean = sum / recentSnapshots.length;

    // Track regime mean
    if (this.regimeSampleCount === 0) {
      this.regimeMean = recentMean;
      this.regimeSampleCount = recentSnapshots.length;
      return;
    }

    // Check if recent mean has shifted significantly from baseline
    const stdDev = this.getStdDev();
    if (stdDev > EPSILON) {
      const shift = Math.abs(recentMean - this.mean);
      const shiftRatio = shift / stdDev;

      // If shift is significant, adapt baseline
      if (shiftRatio > this.config.zScoreThreshold * this.config.regimeChangeSensitivity) {
        this.adaptToRegimeChange(recentSnapshots);
      }
    }

    this.regimeMean = recentMean;
    this.regimeSampleCount = recentSnapshots.length;
  }

  /**
   * Adapt baseline to a new regime
   * Reduces weight of old data while preserving some history
   */
  private adaptToRegimeChange(recentSnapshots: MetricSnapshot[]): void {
    // Recalculate baseline from recent data only
    let newMean = 0;
    let newM2 = 0;
    let count = 0;

    for (const s of recentSnapshots) {
      count++;
      const delta = s.value - newMean;
      newMean += delta / count;
      const delta2 = s.value - newMean;
      newM2 += delta * delta2;
    }

    // Blend old and new baselines (give more weight to recent)
    const blendFactor = 0.7; // 70% recent, 30% historical
    this.mean = blendFactor * newMean + (1 - blendFactor) * this.mean;
    this.m2 = blendFactor * newM2 + (1 - blendFactor) * this.m2;
    this.sampleCount = Math.floor(
      blendFactor * count + (1 - blendFactor) * Math.min(this.sampleCount, this.config.maxWindowSize)
    );
  }

  /**
   * Main anomaly detection logic
   */
  private detectAnomaly(value: number, timestamp: number): AnomalyResult {
    const baselineMean = this.mean;
    const baselineStdDev = this.getStdDev();
    const zScore = calculateZScore(value, baselineMean, baselineStdDev);

    // Calculate spike ratio
    const spikeRatio = this.calculateSpikeRatio(timestamp);

    // Determine anomaly type
    let anomalyType: AnomalyType = 'none';
    let isAnomaly = false;
    const anomalyDetails: string[] = [];

    // Only detect after minimum samples collected
    if (this.sampleCount >= this.config.minSampleCount) {
      // Check z-score anomaly
      if (Math.abs(zScore) >= this.config.zScoreThreshold) {
        isAnomaly = true;
        anomalyType = zScore > 0 ? 'z_score_high' : 'z_score_low';
        anomalyDetails.push(
          `Z-score ${zScore.toFixed(2)} exceeds threshold ±${this.config.zScoreThreshold}`
        );
      }

      // Check spike
      if (spikeRatio !== null && spikeRatio >= this.config.spikeMultiplier) {
        if (isAnomaly) {
          anomalyType = 'combined';
        } else {
          isAnomaly = true;
          anomalyType = 'spike';
        }
        anomalyDetails.push(
          `Spike detected: ${spikeRatio.toFixed(2)}x increase in ${this.config.spikeWindowMs / 1000}s`
        );
      }
    }

    // Calculate confidence based on sample size
    const confidence = this.calculateConfidence();

    return {
      isAnomaly,
      anomalyType,
      zScore: sanitizeValue(zScore),
      currentValue: value,
      ewmaValue: this.ewma,
      baselineMean,
      baselineStdDev,
      spikeRatio,
      confidence,
      details: anomalyDetails.length > 0 ? anomalyDetails.join('; ') : 'No anomaly detected',
    };
  }

  /**
   * Calculate spike ratio by comparing current rate to historical rate
   */
  private calculateSpikeRatio(timestamp: number): number | null {
    const windowStart = timestamp - this.config.spikeWindowMs;
    const windowEnd = timestamp;

    // Get snapshots in the spike window
    const windowSnapshots = this.snapshots.filter(
      s => s.timestamp >= windowStart && s.timestamp <= windowEnd
    );

    if (windowSnapshots.length < 2) {
      return null;
    }

    // Calculate current rate (average of recent values)
    const recentCount = Math.min(5, windowSnapshots.length);
    let recentSum = 0;
    for (let i = windowSnapshots.length - recentCount; i < windowSnapshots.length; i++) {
      recentSum += windowSnapshots[i]!.value;
    }
    const recentAvg = recentSum / recentCount;

    // Calculate historical rate (average of older values in window)
    const olderSnapshots = windowSnapshots.slice(0, -recentCount);
    if (olderSnapshots.length === 0) {
      return null;
    }

    let olderSum = 0;
    for (const s of olderSnapshots) {
      olderSum += s.value;
    }
    const olderAvg = olderSum / olderSnapshots.length;

    // Calculate ratio (handling zero division)
    if (olderAvg < EPSILON) {
      // If baseline is near zero but recent is high, that's a spike
      return recentAvg > EPSILON ? recentAvg / EPSILON : null;
    }

    return safeDivide(recentAvg, olderAvg);
  }

  /**
   * Calculate detection confidence based on sample size
   */
  private calculateConfidence(): number {
    if (this.sampleCount < this.config.minSampleCount) {
      return this.sampleCount / this.config.minSampleCount;
    }

    // Confidence increases with more samples, asymptotically approaching 1
    const excessSamples = this.sampleCount - this.config.minSampleCount;
    return Math.min(1, 0.7 + 0.3 * (1 - Math.exp(-excessSamples / 100)));
  }

  /**
   * Get current standard deviation
   */
  private getStdDev(): number {
    if (this.sampleCount < 2) {
      return 0;
    }
    const variance = this.m2 / (this.sampleCount - 1);
    return safeStdDev(variance);
  }

  /**
   * Get current baseline state
   */
  getBaseline(): BaselineState {
    const variance = this.sampleCount > 1 ? this.m2 / (this.sampleCount - 1) : 0;
    return {
      mean: this.mean,
      variance,
      stdDev: this.getStdDev(),
      ewma: this.ewma,
      ewmaVariance: this.ewmaVariance,
      sampleCount: this.sampleCount,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Load baseline from historical data
   * Useful for restoring state on restart
   */
  loadBaseline(baseline: BaselineState): void {
    this.mean = sanitizeValue(baseline.mean);
    this.m2 = sanitizeValue(baseline.variance * Math.max(0, baseline.sampleCount - 1));
    this.sampleCount = Math.max(0, baseline.sampleCount);
    this.ewma = sanitizeValue(baseline.ewma);
    this.ewmaVariance = sanitizeValue(baseline.ewmaVariance);
    this.ewmaInitialized = this.sampleCount > 0;
  }

  /**
   * Serialize state for persistence
   */
  serialize(): SerializedState {
    return {
      config: this.config,
      baseline: this.getBaseline(),
      recentSnapshots: this.snapshots.toArray(),
      metricKey: this.metricKey,
    };
  }

  /**
   * Deserialize and restore state
   */
  static deserialize(state: SerializedState): AnomalyDetector {
    const detector = new AnomalyDetector(state.metricKey, state.config);
    detector.loadBaseline(state.baseline);

    for (const snapshot of state.recentSnapshots) {
      detector.snapshots.push(snapshot);
    }

    return detector;
  }

  /**
   * Reset detector to initial state
   */
  reset(): void {
    this.mean = 0;
    this.m2 = 0;
    this.sampleCount = 0;
    this.ewma = 0;
    this.ewmaVariance = 0;
    this.ewmaInitialized = false;
    this.lastRegimeCheck = 0;
    this.regimeMean = 0;
    this.regimeSampleCount = 0;
    this.snapshots.clear();
  }

  /**
   * Get metric key
   */
  getMetricKey(): string {
    return this.metricKey;
  }

  /**
   * Get configuration
   */
  getConfig(): AnomalyConfig {
    return { ...this.config };
  }
}

// ============================================================================
// Anomaly Detection Manager
// ============================================================================

export interface AnomalyAlert {
  readonly metricKey: string;
  readonly result: AnomalyResult;
  readonly timestamp: number;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
}

export type AlertCallback = (alert: AnomalyAlert) => void | Promise<void>;

/**
 * Manages multiple anomaly detectors for different metrics
 * Provides a unified interface for the processing pipeline
 */
export class AnomalyDetectionManager {
  private readonly detectors: Map<string, AnomalyDetector> = new Map();
  private readonly defaultConfig: Partial<AnomalyConfig>;
  private readonly alertCallbacks: Set<AlertCallback> = new Set();

  // Performance metrics
  private processedCount: number = 0;
  private totalProcessingTimeNs: bigint = 0n;

  constructor(defaultConfig: Partial<AnomalyConfig> = {}) {
    this.defaultConfig = defaultConfig;
  }

  /**
   * Get or create a detector for a specific metric
   */
  getDetector(metricKey: string): AnomalyDetector {
    let detector = this.detectors.get(metricKey);
    if (!detector) {
      detector = new AnomalyDetector(metricKey, this.defaultConfig);
      this.detectors.set(metricKey, detector);
    }
    return detector;
  }

  /**
   * Process a metric value through the appropriate detector
   */
  process(metricKey: string, value: number, timestamp?: number): AnomalyResult {
    const startTime = process.hrtime.bigint();

    const detector = this.getDetector(metricKey);
    const result = detector.process(value, timestamp);

    // Track performance
    const endTime = process.hrtime.bigint();
    this.processedCount++;
    this.totalProcessingTimeNs = this.totalProcessingTimeNs + (endTime - startTime);

    // Fire alerts if anomaly detected
    if (result.isAnomaly) {
      const alert = this.createAlert(metricKey, result, timestamp ?? Date.now());
      void this.fireAlerts(alert);
    }

    return result;
  }

  /**
   * Batch process multiple metrics
   */
  processBatch(
    metrics: Array<{ key: string; value: number; timestamp?: number }>
  ): AnomalyResult[] {
    return metrics.map(m => this.process(m.key, m.value, m.timestamp));
  }

  /**
   * Register an alert callback
   */
  onAlert(callback: AlertCallback): () => void {
    this.alertCallbacks.add(callback);
    return () => {
      this.alertCallbacks.delete(callback);
    };
  }

  /**
   * Create an alert from an anomaly result
   */
  private createAlert(metricKey: string, result: AnomalyResult, timestamp: number): AnomalyAlert {
    return {
      metricKey,
      result,
      timestamp,
      severity: this.calculateSeverity(result),
    };
  }

  /**
   * Calculate alert severity based on anomaly characteristics
   */
  private calculateSeverity(result: AnomalyResult): AnomalyAlert['severity'] {
    const absZScore = Math.abs(result.zScore);
    const spikeRatio = result.spikeRatio ?? 0;

    if (result.anomalyType === 'combined' || absZScore > 5 || spikeRatio > 10) {
      return 'critical';
    }
    if (absZScore > 4 || spikeRatio > 7) {
      return 'high';
    }
    if (absZScore > 3.5 || spikeRatio > 5) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Fire all registered alert callbacks
   */
  private async fireAlerts(alert: AnomalyAlert): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const callback of this.alertCallbacks) {
      try {
        const result = callback(alert);
        if (result instanceof Promise) {
          promises.push(result.catch(err => {
            console.log('Alert callback error:', err);
          }));
        }
      } catch (err) {
        console.error('Alert callback error:', err);
      }
    }

    await Promise.all(promises);
  }

  /**
   * Get performance statistics
   */
  getPerformanceStats(): {
    processedCount: number;
    avgProcessingTimeMs: number;
    detectorCount: number;
  } {
    const avgTimeNs = this.processedCount > 0
      ? Number(this.totalProcessingTimeNs / BigInt(this.processedCount))
      : 0;

    return {
      processedCount: this.processedCount,
      avgProcessingTimeMs: avgTimeNs / 1_000_000,
      detectorCount: this.detectors.size,
    };
  }

  /**
   * Get all baseline states for persistence
   */
  getAllBaselines(): Map<string, BaselineState> {
    const baselines = new Map<string, BaselineState>();
    for (const [key, detector] of this.detectors) {
      baselines.set(key, detector.getBaseline());
    }
    return baselines;
  }

  /**
   * Load baselines from storage
   */
  loadBaselines(baselines: Map<string, BaselineState>): void {
    for (const [key, baseline] of baselines) {
      const detector = this.getDetector(key);
      detector.loadBaseline(baseline);
    }
  }

  /**
   * Reset all detectors
   */
  resetAll(): void {
    for (const detector of this.detectors.values()) {
      detector.reset();
    }
  }

  /**
   * Remove a specific detector
   */
  removeDetector(metricKey: string): boolean {
    return this.detectors.delete(metricKey);
  }

  /**
   * Clear all detectors and stats
   */
  clear(): void {
    this.detectors.clear();
    this.processedCount = 0;
    this.totalProcessingTimeNs = 0n;
  }
}

// ============================================================================
// Exports
// ============================================================================

export {
  sanitizeValue,
  safeDivide,
  safeStdDev,
  calculateZScore,
  DEFAULT_CONFIG,
  EPSILON,
};

