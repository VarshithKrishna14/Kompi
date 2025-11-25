/**
 * Comprehensive Tests for Anomaly Detection System
 *
 * All tests are deterministic - no Math.random() usage.
 * Tests cover:
 * - Z-score calculations
 * - EWMA computations
 * - Spike detection
 * - Regime change adaptation
 * - Edge cases (Infinity, NaN, zero divisions)
 * - Performance requirements (high throughput, low latency)
 * - Serialization/deserialization
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AnomalyDetector,
  AnomalyDetectionManager,
  sanitizeValue,
  safeDivide,
  safeStdDev,
  calculateZScore,
  EPSILON,
  type AnomalyConfig,
  type BaselineState,
  type AnomalyResult,
} from './anomaly-detector.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Deterministic data generator using linear congruential generator (LCG)
 * This provides reproducible "random" sequences for testing
 */
class DeterministicGenerator {
  private seed: number;

  constructor(seed: number = 12345) {
    this.seed = seed;
  }

  /**
   * Generate next pseudo-random number in range [0, 1)
   */
  next(): number {
    // LCG parameters from Numerical Recipes
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 0xffffffff;
  }

  /**
   * Generate number in range [min, max]
   */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /**
   * Generate array of numbers
   */
  array(length: number, min: number = 0, max: number = 100): number[] {
    const result: number[] = [];
    for (let i = 0; i < length; i++) {
      result.push(this.range(min, max));
    }
    return result;
  }

  /**
   * Generate normally distributed number using Box-Muller transform
   */
  normal(mean: number = 0, stdDev: number = 1): number {
    const u1 = this.next();
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2);
    return mean + z * stdDev;
  }

  /**
   * Reset to initial seed
   */
  reset(seed: number = 12345): void {
    this.seed = seed;
  }
}

/**
 * Create a baseline dataset with known statistics
 */
function createBaselineData(
  count: number,
  mean: number,
  stdDev: number,
  seed: number = 42
): number[] {
  const gen = new DeterministicGenerator(seed);
  const data: number[] = [];
  for (let i = 0; i < count; i++) {
    data.push(gen.normal(mean, stdDev));
  }
  return data;
}

/**
 * Calculate actual mean of an array
 */
function calculateMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Calculate actual standard deviation of an array
 */
function calculateStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = calculateMean(values);
  const sumSquaredDiffs = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0);
  return Math.sqrt(sumSquaredDiffs / (values.length - 1));
}

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('Utility Functions', () => {
  describe('sanitizeValue', () => {
    it('should return 0 for NaN', () => {
      expect(sanitizeValue(NaN)).toBe(0);
    });

    it('should return 0 for Infinity', () => {
      expect(sanitizeValue(Infinity)).toBe(0);
    });

    it('should return 0 for -Infinity', () => {
      expect(sanitizeValue(-Infinity)).toBe(0);
    });

    it('should clamp extremely large positive values', () => {
      const result = sanitizeValue(1e20);
      expect(result).toBeLessThanOrEqual(1e15);
    });

    it('should clamp extremely large negative values', () => {
      const result = sanitizeValue(-1e20);
      expect(result).toBeGreaterThanOrEqual(-1e15);
    });

    it('should pass through normal values unchanged', () => {
      expect(sanitizeValue(42)).toBe(42);
      expect(sanitizeValue(-100.5)).toBe(-100.5);
      expect(sanitizeValue(0)).toBe(0);
    });
  });

  describe('safeDivide', () => {
    it('should return 0 for division by zero', () => {
      expect(safeDivide(10, 0)).toBe(0);
    });

    it('should return 0 for division by very small numbers', () => {
      expect(safeDivide(10, 1e-15)).toBe(0);
    });

    it('should handle normal division correctly', () => {
      expect(safeDivide(10, 2)).toBe(5);
      expect(safeDivide(100, 4)).toBe(25);
    });

    it('should handle division with NaN', () => {
      expect(safeDivide(NaN, 5)).toBe(0);
      expect(safeDivide(10, NaN)).toBe(0);
    });

    it('should handle division with Infinity', () => {
      expect(safeDivide(Infinity, 5)).toBe(0);
      expect(safeDivide(10, Infinity)).toBe(0);
    });
  });

  describe('safeStdDev', () => {
    it('should return 0 for negative variance', () => {
      expect(safeStdDev(-10)).toBe(0);
    });

    it('should return 0 for zero variance', () => {
      expect(safeStdDev(0)).toBe(0);
    });

    it('should calculate correct sqrt for positive values', () => {
      expect(safeStdDev(4)).toBe(2);
      expect(safeStdDev(9)).toBe(3);
      expect(safeStdDev(100)).toBe(10);
    });

    it('should handle NaN and Infinity', () => {
      expect(safeStdDev(NaN)).toBe(0);
      expect(safeStdDev(Infinity)).toBe(0);
    });
  });

  describe('calculateZScore', () => {
    it('should calculate correct z-score', () => {
      // Value 15, mean 10, stdDev 2.5 => z-score = (15-10)/2.5 = 2
      expect(calculateZScore(15, 10, 2.5)).toBe(2);
    });

    it('should handle negative z-scores', () => {
      // Value 5, mean 10, stdDev 2.5 => z-score = (5-10)/2.5 = -2
      expect(calculateZScore(5, 10, 2.5)).toBe(-2);
    });

    it('should return 0 when value equals mean and stdDev is near zero', () => {
      expect(calculateZScore(10, 10, 0)).toBe(0);
    });

    it('should return extreme z-score when stdDev is near zero but value differs', () => {
      expect(calculateZScore(15, 10, 0)).toBe(10);
      expect(calculateZScore(5, 10, 0)).toBe(-10);
    });

    it('should handle edge cases', () => {
      expect(calculateZScore(NaN, 10, 2)).toBe(0);
      expect(calculateZScore(10, NaN, 2)).toBe(0);
      expect(calculateZScore(10, 10, NaN)).toBe(0);
    });
  });
});

// ============================================================================
// AnomalyDetector Core Tests
// ============================================================================

describe('AnomalyDetector', () => {
  let detector: AnomalyDetector;

  beforeEach(() => {
    detector = new AnomalyDetector('test_metric');
  });

  describe('Configuration', () => {
    it('should use default config when none provided', () => {
      const config = detector.getConfig();
      expect(config.zScoreThreshold).toBe(3.0);
      expect(config.ewmaAlpha).toBe(0.3);
      expect(config.spikeWindowMs).toBe(60_000);
      expect(config.spikeMultiplier).toBe(5.0);
      expect(config.minSampleCount).toBe(30);
    });

    it('should allow custom config', () => {
      const customDetector = new AnomalyDetector('custom', {
        zScoreThreshold: 2.5,
        ewmaAlpha: 0.5,
      });
      const config = customDetector.getConfig();
      expect(config.zScoreThreshold).toBe(2.5);
      expect(config.ewmaAlpha).toBe(0.5);
    });

    it('should throw for invalid zScoreThreshold', () => {
      expect(() => {
        new AnomalyDetector('invalid', { zScoreThreshold: 0 });
      }).toThrow('zScoreThreshold must be positive');

      expect(() => {
        new AnomalyDetector('invalid', { zScoreThreshold: -1 });
      }).toThrow('zScoreThreshold must be positive');
    });

    it('should throw for invalid ewmaAlpha', () => {
      expect(() => {
        new AnomalyDetector('invalid', { ewmaAlpha: 0 });
      }).toThrow('ewmaAlpha must be in range (0, 1]');

      expect(() => {
        new AnomalyDetector('invalid', { ewmaAlpha: 1.5 });
      }).toThrow('ewmaAlpha must be in range (0, 1]');
    });

    it('should throw for invalid spikeMultiplier', () => {
      expect(() => {
        new AnomalyDetector('invalid', { spikeMultiplier: 1 });
      }).toThrow('spikeMultiplier must be greater than 1');
    });
  });

  describe('Baseline Learning', () => {
    it('should learn correct mean from data', () => {
      // Feed exactly 100 values with known properties
      const values = createBaselineData(100, 50, 10, 42);
      let timestamp = 1000000;

      for (const v of values) {
        detector.process(v, timestamp);
        timestamp += 1000;
      }

      const baseline = detector.getBaseline();
      const actualMean = calculateMean(values);

      // Welford's algorithm should compute very accurate mean
      expect(baseline.mean).toBeCloseTo(actualMean, 10);
    });

    it('should learn correct standard deviation from data', () => {
      const values = createBaselineData(100, 50, 10, 42);
      let timestamp = 1000000;

      for (const v of values) {
        detector.process(v, timestamp);
        timestamp += 1000;
      }

      const baseline = detector.getBaseline();
      const actualStdDev = calculateStdDev(values);

      // Should be within 1% of actual
      expect(baseline.stdDev).toBeCloseTo(actualStdDev, 1);
    });

    it('should track sample count correctly', () => {
      for (let i = 0; i < 50; i++) {
        detector.process(i, 1000000 + i * 1000);
      }

      const baseline = detector.getBaseline();
      expect(baseline.sampleCount).toBe(50);
    });
  });

  describe('EWMA Calculations', () => {
    it('should initialize EWMA with first value', () => {
      detector.process(100, 1000000);
      const baseline = detector.getBaseline();
      expect(baseline.ewma).toBe(100);
    });

    it('should update EWMA correctly', () => {
      const alpha = 0.3; // default
      detector.process(100, 1000000);
      detector.process(200, 1001000);

      // EWMA after second value: 100 + 0.3 * (200 - 100) = 130
      const baseline = detector.getBaseline();
      expect(baseline.ewma).toBeCloseTo(130, 5);
    });

    it('should converge EWMA to steady state', () => {
      // Feed constant value, EWMA should converge to it
      for (let i = 0; i < 100; i++) {
        detector.process(50, 1000000 + i * 1000);
      }

      const baseline = detector.getBaseline();
      expect(baseline.ewma).toBeCloseTo(50, 5);
    });
  });

  describe('Z-Score Anomaly Detection', () => {
    it('should not detect anomaly before minimum samples', () => {
      // With default minSampleCount of 30, first 29 should not trigger
      for (let i = 0; i < 29; i++) {
        const result = detector.process(50, 1000000 + i * 1000);
        expect(result.isAnomaly).toBe(false);
      }
    });

    it('should detect high z-score anomaly', () => {
      // Train on values around 50 with stdDev ~10
      const values = createBaselineData(50, 50, 10, 42);
      let timestamp = 1000000;

      for (const v of values) {
        detector.process(v, timestamp);
        timestamp += 1000;
      }

      // Now inject a value that is 4 standard deviations above mean
      const baseline = detector.getBaseline();
      const anomalyValue = baseline.mean + baseline.stdDev * 4;

      const result = detector.process(anomalyValue, timestamp);

      expect(result.isAnomaly).toBe(true);
      expect(result.anomalyType).toBe('z_score_high');
      expect(result.zScore).toBeGreaterThan(3);
    });

    it('should detect low z-score anomaly', () => {
      const values = createBaselineData(50, 50, 10, 42);
      let timestamp = 1000000;

      for (const v of values) {
        detector.process(v, timestamp);
        timestamp += 1000;
      }

      const baseline = detector.getBaseline();
      const anomalyValue = baseline.mean - baseline.stdDev * 4;

      const result = detector.process(anomalyValue, timestamp);

      expect(result.isAnomaly).toBe(true);
      expect(result.anomalyType).toBe('z_score_low');
      expect(result.zScore).toBeLessThan(-3);
    });

    it('should not detect anomaly for normal values', () => {
      const values = createBaselineData(50, 50, 10, 42);
      let timestamp = 1000000;

      for (const v of values) {
        detector.process(v, timestamp);
        timestamp += 1000;
      }

      // Value within 2 stdDev should not trigger
      const baseline = detector.getBaseline();
      const normalValue = baseline.mean + baseline.stdDev * 2;

      const result = detector.process(normalValue, timestamp);
      expect(result.isAnomaly).toBe(false);
      expect(result.anomalyType).toBe('none');
    });
  });

  describe('Spike Detection', () => {
    it('should detect sudden spike', () => {
      const spikeDetector = new AnomalyDetector('spike_test', {
        spikeWindowMs: 10000, // 10 second window
        spikeMultiplier: 5,
        minSampleCount: 10,
      });

      // Feed low values for baseline
      let timestamp = 1000000;
      for (let i = 0; i < 15; i++) {
        spikeDetector.process(1, timestamp);
        timestamp += 500;
      }

      // Now spike up
      for (let i = 0; i < 5; i++) {
        const result = spikeDetector.process(10, timestamp);
        timestamp += 500;

        // After a few high values, spike should be detected
        if (i >= 2) {
          expect(result.spikeRatio).not.toBeNull();
          if (result.spikeRatio !== null && result.spikeRatio >= 5) {
            expect(result.isAnomaly).toBe(true);
          }
        }
      }
    });

    it('should not detect spike for gradual increase', () => {
      const spikeDetector = new AnomalyDetector('gradual_test', {
        spikeWindowMs: 60000,
        spikeMultiplier: 5,
        minSampleCount: 10,
      });

      let timestamp = 1000000;
      // Gradual increase from 1 to 5 over time
      for (let i = 0; i < 50; i++) {
        const value = 1 + (i / 50) * 4;
        const result = spikeDetector.process(value, timestamp);
        timestamp += 2000;

        // Gradual increase should not trigger spike
        if (result.spikeRatio !== null) {
          expect(result.spikeRatio).toBeLessThan(5);
        }
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle NaN input gracefully', () => {
      const result = detector.process(NaN, 1000000);
      expect(result.currentValue).toBe(0);
      expect(result.isAnomaly).toBe(false);
    });

    it('should handle Infinity input gracefully', () => {
      const result = detector.process(Infinity, 1000000);
      expect(result.currentValue).toBe(0);
      expect(result.isAnomaly).toBe(false);
    });

    it('should handle negative Infinity input gracefully', () => {
      const result = detector.process(-Infinity, 1000000);
      expect(result.currentValue).toBe(0);
      expect(result.isAnomaly).toBe(false);
    });

    it('should handle extremely large values', () => {
      const result = detector.process(1e30, 1000000);
      expect(Number.isFinite(result.currentValue)).toBe(true);
    });

    it('should handle all zeros', () => {
      for (let i = 0; i < 50; i++) {
        const result = detector.process(0, 1000000 + i * 1000);
        expect(result.currentValue).toBe(0);
        expect(Number.isFinite(result.zScore)).toBe(true);
      }
    });

    it('should handle constant values', () => {
      for (let i = 0; i < 50; i++) {
        detector.process(42, 1000000 + i * 1000);
      }

      const baseline = detector.getBaseline();
      expect(baseline.mean).toBe(42);
      expect(baseline.stdDev).toBe(0); // No variance
    });
  });

  describe('Serialization', () => {
    it('should serialize and deserialize correctly', () => {
      // Train detector
      const values = createBaselineData(50, 50, 10, 42);
      let timestamp = 1000000;

      for (const v of values) {
        detector.process(v, timestamp);
        timestamp += 1000;
      }

      // Serialize
      const serialized = detector.serialize();

      // Deserialize
      const restored = AnomalyDetector.deserialize(serialized);

      // Check state matches
      const originalBaseline = detector.getBaseline();
      const restoredBaseline = restored.getBaseline();

      expect(restoredBaseline.mean).toBeCloseTo(originalBaseline.mean, 10);
      expect(restoredBaseline.stdDev).toBeCloseTo(originalBaseline.stdDev, 10);
      expect(restoredBaseline.ewma).toBeCloseTo(originalBaseline.ewma, 10);
      expect(restoredBaseline.sampleCount).toBe(originalBaseline.sampleCount);
    });

    it('should preserve metric key through serialization', () => {
      const serialized = detector.serialize();
      expect(serialized.metricKey).toBe('test_metric');

      const restored = AnomalyDetector.deserialize(serialized);
      expect(restored.getMetricKey()).toBe('test_metric');
    });
  });

  describe('Reset', () => {
    it('should reset all state', () => {
      // Train detector
      for (let i = 0; i < 100; i++) {
        detector.process(i, 1000000 + i * 1000);
      }

      // Verify state exists
      let baseline = detector.getBaseline();
      expect(baseline.sampleCount).toBe(100);

      // Reset
      detector.reset();

      // Verify state is cleared
      baseline = detector.getBaseline();
      expect(baseline.sampleCount).toBe(0);
      expect(baseline.mean).toBe(0);
      expect(baseline.ewma).toBe(0);
    });
  });
});

// ============================================================================
// Regime Change Tests
// ============================================================================

describe('Regime Change Detection', () => {
  it('should adapt to baseline shift', () => {
    const detector = new AnomalyDetector('regime_test', {
      regimeWindowMs: 10000,
      regimeChangeSensitivity: 0.2,
      minSampleCount: 20,
    });

    let timestamp = 1000000;

    // First regime: values around 10
    for (let i = 0; i < 50; i++) {
      detector.process(10 + (i % 5 - 2), timestamp);
      timestamp += 500;
    }

    const baseline1 = detector.getBaseline();
    expect(baseline1.mean).toBeCloseTo(10, 0);

    // Second regime: values around 50 (shift)
    for (let i = 0; i < 100; i++) {
      detector.process(50 + (i % 5 - 2), timestamp);
      timestamp += 500;
    }

    const baseline2 = detector.getBaseline();

    // After regime change, baseline should adapt toward new values
    // It won't fully reach 50 due to blending, but should be significantly higher
    expect(baseline2.mean).toBeGreaterThan(baseline1.mean + 10);
  });
});

// ============================================================================
// AnomalyDetectionManager Tests
// ============================================================================

describe('AnomalyDetectionManager', () => {
  let manager: AnomalyDetectionManager;

  beforeEach(() => {
    manager = new AnomalyDetectionManager();
  });

  describe('Detector Management', () => {
    it('should create new detector on first access', () => {
      const detector = manager.getDetector('new_metric');
      expect(detector).toBeInstanceOf(AnomalyDetector);
      expect(detector.getMetricKey()).toBe('new_metric');
    });

    it('should return same detector on subsequent access', () => {
      const detector1 = manager.getDetector('my_metric');
      const detector2 = manager.getDetector('my_metric');
      expect(detector1).toBe(detector2);
    });

    it('should create separate detectors for different metrics', () => {
      const detector1 = manager.getDetector('metric_a');
      const detector2 = manager.getDetector('metric_b');
      expect(detector1).not.toBe(detector2);
    });

    it('should remove detector', () => {
      manager.getDetector('to_remove');
      const removed = manager.removeDetector('to_remove');
      expect(removed).toBe(true);

      // Getting it again should create new one
      const newDetector = manager.getDetector('to_remove');
      expect(newDetector.getBaseline().sampleCount).toBe(0);
    });
  });

  describe('Processing', () => {
    it('should process single metric', () => {
      const result = manager.process('test', 42, 1000000);
      expect(result.currentValue).toBe(42);
      expect(result.isAnomaly).toBe(false);
    });

    it('should process batch of metrics', () => {
      const metrics = [
        { key: 'metric_a', value: 10, timestamp: 1000000 },
        { key: 'metric_b', value: 20, timestamp: 1000000 },
        { key: 'metric_c', value: 30, timestamp: 1000000 },
      ];

      const results = manager.processBatch(metrics);
      expect(results).toHaveLength(3);
      expect(results[0]?.currentValue).toBe(10);
      expect(results[1]?.currentValue).toBe(20);
      expect(results[2]?.currentValue).toBe(30);
    });
  });

  describe('Alert Callbacks', () => {
    it('should fire alert callback on anomaly', async () => {
      const alerts: Array<{ metricKey: string; severity: string }> = [];

      manager.onAlert((alert) => {
        alerts.push({ metricKey: alert.metricKey, severity: alert.severity });
      });

      // Train and then inject anomaly
      let timestamp = 1000000;
      for (let i = 0; i < 50; i++) {
        manager.process('alertable', 10, timestamp);
        timestamp += 1000;
      }

      // Inject extreme anomaly
      manager.process('alertable', 1000, timestamp);

      // Wait for async callbacks
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0]?.metricKey).toBe('alertable');
    });

    it('should allow unsubscribing from alerts', () => {
      const alerts: string[] = [];

      const unsubscribe = manager.onAlert((alert) => {
        alerts.push(alert.metricKey);
      });

      // Unsubscribe
      unsubscribe();

      // Train and inject anomaly
      let timestamp = 1000000;
      for (let i = 0; i < 50; i++) {
        manager.process('unsubscribed', 10, timestamp);
        timestamp += 1000;
      }
      manager.process('unsubscribed', 1000, timestamp);

      // No alerts should be recorded
      expect(alerts).toHaveLength(0);
    });
  });

  describe('Performance Statistics', () => {
    it('should track processing count', () => {
      for (let i = 0; i < 100; i++) {
        manager.process('perf_test', i, 1000000 + i * 1000);
      }

      const stats = manager.getPerformanceStats();
      expect(stats.processedCount).toBe(100);
      expect(stats.detectorCount).toBe(1);
    });

    it('should track average processing time', () => {
      for (let i = 0; i < 100; i++) {
        manager.process('perf_test', i, 1000000 + i * 1000);
      }

      const stats = manager.getPerformanceStats();
      expect(stats.avgProcessingTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Baseline Persistence', () => {
    it('should get all baselines', () => {
      manager.process('metric_1', 10, 1000000);
      manager.process('metric_2', 20, 1000000);
      manager.process('metric_3', 30, 1000000);

      const baselines = manager.getAllBaselines();
      expect(baselines.size).toBe(3);
      expect(baselines.has('metric_1')).toBe(true);
      expect(baselines.has('metric_2')).toBe(true);
      expect(baselines.has('metric_3')).toBe(true);
    });

    it('should load baselines', () => {
      const baselines = new Map<string, BaselineState>();
      baselines.set('loaded_metric', {
        mean: 100,
        variance: 25,
        stdDev: 5,
        ewma: 100,
        ewmaVariance: 25,
        sampleCount: 1000,
        lastUpdated: Date.now(),
      });

      manager.loadBaselines(baselines);

      const detector = manager.getDetector('loaded_metric');
      const baseline = detector.getBaseline();

      expect(baseline.mean).toBe(100);
      expect(baseline.sampleCount).toBe(1000);
    });
  });

  describe('Clear and Reset', () => {
    it('should reset all detectors', () => {
      manager.process('reset_test', 10, 1000000);

      manager.resetAll();

      const detector = manager.getDetector('reset_test');
      expect(detector.getBaseline().sampleCount).toBe(0);
    });

    it('should clear everything', () => {
      manager.process('clear_test', 10, 1000000);

      manager.clear();

      const stats = manager.getPerformanceStats();
      expect(stats.processedCount).toBe(0);
      expect(stats.detectorCount).toBe(0);
    });
  });
});

// ============================================================================
// Performance Tests
// ============================================================================

describe('Performance', () => {
  it('should process 100,000 logs with low latency', () => {
    const manager = new AnomalyDetectionManager();
    const gen = new DeterministicGenerator(42);

    const startTime = process.hrtime.bigint();

    // Process 100,000 metric updates
    for (let i = 0; i < 100_000; i++) {
      const value = gen.range(0, 100);
      manager.process('perf_metric', value, 1000000 + i * 60);
    }

    const endTime = process.hrtime.bigint();
    const totalTimeMs = Number(endTime - startTime) / 1_000_000;

    const stats = manager.getPerformanceStats();

    // Total time should be reasonable (under 5 seconds for 100k operations)
    expect(totalTimeMs).toBeLessThan(5000);

    // Average per-operation should be under 10ms (requirement)
    expect(stats.avgProcessingTimeMs).toBeLessThan(10);

    console.log(`Processed 100,000 metrics in ${totalTimeMs.toFixed(2)}ms`);
    console.log(`Average per-operation: ${stats.avgProcessingTimeMs.toFixed(4)}ms`);
  });

  it('should handle multiple metric streams efficiently', () => {
    const manager = new AnomalyDetectionManager();
    const gen = new DeterministicGenerator(42);

    const startTime = process.hrtime.bigint();

    // Process 10,000 updates across 100 different metrics
    for (let i = 0; i < 10_000; i++) {
      const metricIdx = i % 100;
      const value = gen.range(0, 100);
      manager.process(`service_${metricIdx}`, value, 1000000 + i * 60);
    }

    const endTime = process.hrtime.bigint();
    const totalTimeMs = Number(endTime - startTime) / 1_000_000;

    const stats = manager.getPerformanceStats();

    expect(stats.detectorCount).toBe(100);
    expect(stats.avgProcessingTimeMs).toBeLessThan(10);

    console.log(`Processed 10,000 metrics across 100 streams in ${totalTimeMs.toFixed(2)}ms`);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Integration', () => {
  it('should detect error rate anomaly in realistic scenario', () => {
    const manager = new AnomalyDetectionManager({
      minSampleCount: 20,
      zScoreThreshold: 3,
    });

    let timestamp = 1000000;
    const alerts: AnomalyResult[] = [];

    // Normal operation: 1% error rate (0.01)
    for (let i = 0; i < 100; i++) {
      const errorRate = 0.01 + (i % 10) * 0.001; // Small variation around 1%
      const result = manager.process('api_service', errorRate, timestamp);
      if (result.isAnomaly) {
        alerts.push(result);
      }
      timestamp += 1000;
    }

    // Incident: error rate jumps to 20%
    const incidentResult = manager.process('api_service', 0.20, timestamp);

    // Should detect anomaly
    expect(incidentResult.isAnomaly).toBe(true);
    expect(incidentResult.zScore).toBeGreaterThan(3);
  });

  it('should handle mixed normal and anomalous traffic', () => {
    const manager = new AnomalyDetectionManager({
      minSampleCount: 30,
    });

    let timestamp = 1000000;
    const gen = new DeterministicGenerator(42);

    // Phase 1: Normal traffic
    for (let i = 0; i < 50; i++) {
      manager.process('web_server', gen.normal(100, 10), timestamp);
      timestamp += 1000;
    }

    // Phase 2: Some anomalies mixed in
    let anomalyCount = 0;
    for (let i = 0; i < 20; i++) {
      const isAnomaly = i % 5 === 0; // Every 5th is anomaly
      const value = isAnomaly ? 300 : gen.normal(100, 10);
      const result = manager.process('web_server', value, timestamp);
      if (result.isAnomaly) {
        anomalyCount++;
      }
      timestamp += 1000;
    }

    // Should detect most anomalies
    expect(anomalyCount).toBeGreaterThanOrEqual(2);
  });

  it('should provide actionable alert details', () => {
    const manager = new AnomalyDetectionManager({
      minSampleCount: 20,
    });

    let timestamp = 1000000;

    // Train baseline
    for (let i = 0; i < 50; i++) {
      manager.process('database', 50 + (i % 5), timestamp);
      timestamp += 1000;
    }

    // Trigger anomaly
    const result = manager.process('database', 200, timestamp);

    expect(result.isAnomaly).toBe(true);
    expect(result.details).toContain('Z-score');
    expect(result.details).toContain('threshold');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.baselineMean).toBeCloseTo(52, 0);
    expect(result.baselineStdDev).toBeGreaterThan(0);
  });
});

// ============================================================================
// Confidence Calculation Tests
// ============================================================================

describe('Confidence Calculation', () => {
  it('should have low confidence before minimum samples', () => {
    const detector = new AnomalyDetector('conf_test', {
      minSampleCount: 30,
    });

    const result = detector.process(10, 1000000);
    expect(result.confidence).toBeLessThan(0.1);
  });

  it('should increase confidence as samples grow', () => {
    const detector = new AnomalyDetector('conf_test', {
      minSampleCount: 30,
    });

    let lastConfidence = 0;
    for (let i = 0; i < 100; i++) {
      const result = detector.process(50, 1000000 + i * 1000);
      if (i > 30) {
        expect(result.confidence).toBeGreaterThanOrEqual(lastConfidence - 0.01);
      }
      lastConfidence = result.confidence;
    }
  });

  it('should approach 1.0 confidence asymptotically', () => {
    const detector = new AnomalyDetector('conf_test', {
      minSampleCount: 30,
    });

    for (let i = 0; i < 500; i++) {
      detector.process(50, 1000000 + i * 1000);
    }

    const result = detector.process(50, 2000000);
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.confidence).toBeLessThanOrEqual(1.0);
  });
});

