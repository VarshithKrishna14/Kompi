// Statistical anomaly detection for error rates using EWMA, z-scores, and rate-of-change spikes.
// Designed for streaming workloads (100k+ logs/min) with O(1) per-point latency.

export interface AnomalyPoint {
    /** Unix timestamp in milliseconds */
    timestamp: number;
    /** Number of error logs in this bucket */
    errorCount: number;
    /** Total number of logs in this bucket */
    totalCount: number;
  }
  
  export interface ZScoreComponent {
    zScore: number;
    threshold: number;
    isAnomaly: boolean;
  }
  
  export interface SpikeComponent {
    windowErrorRate: number;
    baselineErrorRate: number;
    factor: number;
    factorThreshold: number;
    isAnomaly: boolean;
  }
  
  export interface AnomalyDetectionResult {
    isAnomaly: boolean;
    zScoreComponent: ZScoreComponent;
    spikeComponent: SpikeComponent;
    /** Snapshot of internal state that can be safely logged for debugging/observability */
    state: {
      sampleCount: number;
      ewmaErrorRate: number;
      ewmaErrorRateSq: number;
      stdDev: number;
      lastTimestamp: number | null;
    };
  }
  
  export interface AnomalyDetectorConfig {
    /**
     * EWMA smoothing factor in (0, 1].
     * Higher alpha -> faster adaptation to regime changes but more noise.
     */
    ewmaAlpha: number;
    /** Minimum number of samples before we trust z-score based anomalies. */
    minSamplesForZScore: number;
    /** Absolute z-score threshold above which we flag anomalies. */
    zScoreThreshold: number;
    /**
     * Time window (ms) over which to measure rate-of-change spikes.
     * Typical: 60_000 for 60 seconds.
     */
    spikeWindowMs: number;
    /** Multiplicative spike factor threshold (e.g. 5 => 5x increase vs baseline). */
    spikeFactorThreshold: number;
    /**
     * Minimum total log volume in the spike window before we trust spike detection.
     * Prevents tiny baselines from triggering infinite factors.
     */
    minWindowTotalCount: number;
    /**
     * Small epsilon used to avoid division by zero and numerical instability.
     */
    epsilon: number;
  }
  
  const DEFAULT_CONFIG: AnomalyDetectorConfig = {
    ewmaAlpha: 0.1,
    minSamplesForZScore: 30,
    zScoreThreshold: 3.0,
    spikeWindowMs: 60_000,
    spikeFactorThreshold: 5,
    minWindowTotalCount: 100,
    epsilon: 1e-9,
  };
  
  function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
  }
  
  function safeDivide(numerator: number, denominator: number, fallback: number): number {
    if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator)) {
      return fallback;
    }
    if (denominator === 0) {
      return fallback;
    }
    const result = numerator / denominator;
    return Number.isFinite(result) ? result : fallback;
  }
  
  interface WindowBucket {
    timestamp: number;
    errorCount: number;
    totalCount: number;
  }
  
  /**
   * AnomalyDetector maintains online statistics for error-rate anomalies.
   *
   * - Learns baseline error rate using EWMA of errorRate and errorRate^2
   * - Uses z-scores to detect statistically significant deviations
   * - Uses a sliding time window to detect multiplicative spikes (e.g. 5x in 60s)
   * - Handles NaN/Infinity and zero divisions defensively
   */
  export class AnomalyDetector {
    private readonly config: AnomalyDetectorConfig;
  
    private sampleCount = 0;
    private ewmaErrorRate = 0;
    private ewmaErrorRateSq = 0;
    private lastTimestamp: number | null = null;
  
    // Sliding window for spike detection
    private windowBuckets: WindowBucket[] = [];
    private windowErrorCount = 0;
    private windowTotalCount = 0;
  
    constructor(config?: Partial<AnomalyDetectorConfig>) {
      this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
      this.validateConfig(this.config);
    }
  
    private validateConfig(cfg: AnomalyDetectorConfig): void {
      if (!(cfg.ewmaAlpha > 0 && cfg.ewmaAlpha <= 1)) {
        throw new Error(`ewmaAlpha must be in (0, 1], got ${cfg.ewmaAlpha}`);
      }
      if (cfg.minSamplesForZScore < 1) {
        throw new Error(`minSamplesForZScore must be >= 1, got ${cfg.minSamplesForZScore}`);
      }
      if (cfg.zScoreThreshold <= 0) {
        throw new Error(`zScoreThreshold must be > 0, got ${cfg.zScoreThreshold}`);
      }
      if (cfg.spikeWindowMs <= 0) {
        throw new Error(`spikeWindowMs must be > 0, got ${cfg.spikeWindowMs}`);
      }
      if (cfg.spikeFactorThreshold <= 1) {
        throw new Error(`spikeFactorThreshold must be > 1, got ${cfg.spikeFactorThreshold}`);
      }
      if (cfg.minWindowTotalCount < 0) {
        throw new Error(`minWindowTotalCount must be >= 0, got ${cfg.minWindowTotalCount}`);
      }
      if (cfg.epsilon <= 0) {
        throw new Error(`epsilon must be > 0, got ${cfg.epsilon}`);
      }
    }
  
    /**
     * Reset all internal state. Useful when you want to explicitly discard history,
     * e.g. after a known deployment causing a step change in error behavior.
     */
    public reset(): void {
      this.sampleCount = 0;
      this.ewmaErrorRate = 0;
      this.ewmaErrorRateSq = 0;
      this.lastTimestamp = null;
      this.windowBuckets = [];
      this.windowErrorCount = 0;
      this.windowTotalCount = 0;
    }
  
    /**
     * Ingest a new aggregated point of error/total counts and return anomaly decision.
     *
     * This method is designed to be called for every aggregation bucket
     * (e.g. once per second per service/endpoint).
     */
    public detect(point: AnomalyPoint): AnomalyDetectionResult {
      const { timestamp, errorCount, totalCount } = point;
  
      if (!Number.isFinite(timestamp)) {
        throw new Error(`timestamp must be a finite number, got ${timestamp}`);
      }
  
      if (timestamp < 0) {
        throw new Error(`timestamp must be non-negative, got ${timestamp}`);
      }
  
      if (!Number.isInteger(errorCount) || !Number.isInteger(totalCount)) {
        throw new Error("errorCount and totalCount must be integers");
      }
  
      if (errorCount < 0 || totalCount < 0) {
        throw new Error("errorCount and totalCount must be non-negative");
      }
  
      if (errorCount > totalCount) {
        // Clamp obviously invalid inputs; don't let them corrupt the model.
        // Logically, errorCount cannot exceed totalCount.
        // We clamp instead of throwing to favor availability.
        const clampedErrorCount = totalCount;
        return this.detect({ timestamp, errorCount: clampedErrorCount, totalCount });
      }
  
      if (this.lastTimestamp !== null && timestamp < this.lastTimestamp) {
        // Out-of-order data: we ignore spike window effects but still update EWMA.
        // This keeps the detector robust to slight clock skew.
        // We do not throw to avoid breaking the pipeline.
      }
      this.lastTimestamp = timestamp;
  
      const errorRate = safeDivide(errorCount, totalCount, 0);
  
      // Update EWMA of errorRate and errorRate^2 for variance estimation.
      const alpha = this.config.ewmaAlpha;
      if (this.sampleCount === 0) {
        this.ewmaErrorRate = errorRate;
        this.ewmaErrorRateSq = errorRate * errorRate;
      } else {
        this.ewmaErrorRate = alpha * errorRate + (1 - alpha) * this.ewmaErrorRate;
        const rateSq = errorRate * errorRate;
        this.ewmaErrorRateSq = alpha * rateSq + (1 - alpha) * this.ewmaErrorRateSq;
      }
      this.sampleCount += 1;
  
      // Numerically stable variance: E[x^2] - (E[x])^2, clamped to >= 0.
      let variance = this.ewmaErrorRateSq - this.ewmaErrorRate * this.ewmaErrorRate;
      if (!Number.isFinite(variance) || Number.isNaN(variance)) {
        variance = 0;
      }
      if (variance < 0) {
        variance = 0;
      }
      const stdDev = Math.sqrt(variance);
  
      let zScore = 0;
      if (stdDev > this.config.epsilon) {
        const rawZ = (errorRate - this.ewmaErrorRate) / stdDev;
        zScore = Number.isFinite(rawZ) ? rawZ : 0;
      }
  
      const zScoreComponent: ZScoreComponent = {
        zScore,
        threshold: this.config.zScoreThreshold,
        isAnomaly:
          this.sampleCount >= this.config.minSamplesForZScore &&
          Math.abs(zScore) >= this.config.zScoreThreshold,
      };
  
      // Update sliding window for spike detection.
      this.addToWindow({ timestamp, errorCount, totalCount });
      this.evictOldFromWindow(timestamp);
  
      const windowErrorRate = safeDivide(this.windowErrorCount, this.windowTotalCount, 0);
      const baselineErrorRate = this.ewmaErrorRate;
  
      let spikeFactor = 1;
      if (baselineErrorRate > this.config.epsilon) {
        const factor = windowErrorRate / baselineErrorRate;
        spikeFactor = Number.isFinite(factor) ? factor : 1;
      } else {
        // If baseline is effectively zero but window shows errors, treat as a large spike.
        if (windowErrorRate > this.config.epsilon) {
          spikeFactor = this.config.spikeFactorThreshold + 1;
        } else {
          spikeFactor = 1;
        }
      }
  
      const spikeComponent: SpikeComponent = {
        windowErrorRate,
        baselineErrorRate,
        factor: spikeFactor,
        factorThreshold: this.config.spikeFactorThreshold,
        isAnomaly:
          this.windowTotalCount >= this.config.minWindowTotalCount &&
          spikeFactor >= this.config.spikeFactorThreshold,
      };
  
      const isAnomaly = zScoreComponent.isAnomaly || spikeComponent.isAnomaly;
  
      return {
        isAnomaly,
        zScoreComponent,
        spikeComponent,
        state: {
          sampleCount: this.sampleCount,
          ewmaErrorRate: this.ewmaErrorRate,
          ewmaErrorRateSq: this.ewmaErrorRateSq,
          stdDev,
          lastTimestamp: this.lastTimestamp,
        },
      };
    }
  
    private addToWindow(bucket: WindowBucket): void {
      this.windowBuckets.push(bucket);
      this.windowErrorCount += bucket.errorCount;
      this.windowTotalCount += bucket.totalCount;
    }
  
    private evictOldFromWindow(now: number): void {
      const cutoff = now - this.config.spikeWindowMs;
      let idx = 0;
      const buckets = this.windowBuckets;
      while (idx < buckets.length && buckets[idx].timestamp < cutoff) {
        const b = buckets[idx];
        this.windowErrorCount -= b.errorCount;
        this.windowTotalCount -= b.totalCount;
        idx += 1;
      }
      if (idx > 0) {
        this.windowBuckets = buckets.slice(idx);
      }
      if (this.windowErrorCount < 0) this.windowErrorCount = 0;
      if (this.windowTotalCount < 0) this.windowTotalCount = 0;
    }
  }
  
  
  