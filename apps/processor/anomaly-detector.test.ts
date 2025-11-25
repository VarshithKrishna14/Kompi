import { AnomalyDetector } from "./anomaly-detector";

function makeDetector(overrides?: Parameters<typeof AnomalyDetector>[0]) {
  return new AnomalyDetector({
    ewmaAlpha: 0.2,
    minSamplesForZScore: 5,
    zScoreThreshold: 2.0,
    spikeWindowMs: 60_000,
    spikeFactorThreshold: 5,
    minWindowTotalCount: 10,
    ...(overrides ?? {}),
  });
}

describe("AnomalyDetector - EWMA and z-score behavior", () => {
  it("does not flag anomalies for stable low error rate", () => {
    const detector = makeDetector();

    let anyAnomaly = false;
    let timestamp = 0;

    for (let i = 0; i < 100; i += 1) {
      timestamp += 1000;
      const res = detector.detect({
        timestamp,
        errorCount: 1,
        totalCount: 100,
      });
      if (res.isAnomaly) {
        anyAnomaly = true;
        break;
      }
    }

    expect(anyAnomaly).toBe(false);
  });

  it("flags z-score anomalies when error rate jumps and persists", () => {
    const detector = makeDetector();
    let timestamp = 0;

    // Warm-up at 1% error
    for (let i = 0; i < 50; i += 1) {
      timestamp += 1000;
      detector.detect({
        timestamp,
        errorCount: 1,
        totalCount: 100,
      });
    }

    // Now jump to 20% error
    let anomalyDetected = false;
    for (let i = 0; i < 10; i += 1) {
      timestamp += 1000;
      const res = detector.detect({
        timestamp,
        errorCount: 20,
        totalCount: 100,
      });
      if (res.zScoreComponent.isAnomaly) {
        anomalyDetected = true;
        break;
      }
    }

    expect(anomalyDetected).toBe(true);
  });
});

describe("AnomalyDetector - spike detection", () => {
  it("detects a 5x spike in error rate within the window", () => {
    const spikeWindowMs = 60_000;
    const detector = makeDetector({
      spikeWindowMs,
      minWindowTotalCount: 20,
      spikeFactorThreshold: 5,
    });

    let timestamp = 0;

    // Baseline: 1% error, enough samples to stabilize baseline
    for (let i = 0; i < 60; i += 1) {
      timestamp += 1000;
      detector.detect({
        timestamp,
        errorCount: 1,
        totalCount: 100,
      });
    }

    // Within one window, jump to 20% error (20x baseline)
    let spikeDetected = false;
    for (let i = 0; i < 20; i += 1) {
      timestamp += 1000;
      const res = detector.detect({
        timestamp,
        errorCount: 20,
        totalCount: 100,
      });
      if (res.spikeComponent.isAnomaly) {
        spikeDetected = true;
        break;
      }
    }

    expect(spikeDetected).toBe(true);
  });

  it("does not spuriously trigger spikes when baseline is near zero and window volume is tiny", () => {
    const detector = makeDetector({
      minWindowTotalCount: 100, // require high volume for a spike
    });

    let timestamp = 0;

    // Mostly zero logs with an occasional error
    for (let i = 0; i < 20; i += 1) {
      timestamp += 1000;
      const res = detector.detect({
        timestamp,
        errorCount: i === 10 ? 1 : 0,
        totalCount: 1,
      });
      expect(res.spikeComponent.isAnomaly).toBe(false);
    }
  });
});

describe("AnomalyDetector - edge cases and numerical stability", () => {
  it("handles zero totalCount without throwing or producing NaN", () => {
    const detector = makeDetector();
    const res = detector.detect({
      timestamp: Date.now(),
      errorCount: 0,
      totalCount: 0,
    });

    expect(res.isAnomaly).toBe(false);
    expect(Number.isFinite(res.state.ewmaErrorRate)).toBe(true);
  });

  it("clamps invalid errorCount > totalCount", () => {
    const detector = makeDetector();
    const res = detector.detect({
      timestamp: Date.now(),
      errorCount: 10,
      totalCount: 5,
    });

    // Still processes, but with clamped errorCount
    expect(res.isAnomaly).toBe(false);
  });

  it("rejects negative counts", () => {
    const detector = makeDetector();

    expect(() =>
      detector.detect({
        timestamp: Date.now(),
        errorCount: -1,
        totalCount: 10,
      }),
    ).toThrow();

    expect(() =>
      detector.detect({
        timestamp: Date.now(),
        errorCount: 1,
        totalCount: -10,
      }),
    ).toThrow();
  });

  it("rejects non-finite timestamps", () => {
    const detector = makeDetector();

    expect(() =>
      detector.detect({
        // eslint-disable-next-line no-restricted-globals
        timestamp: NaN as unknown as number,
        errorCount: 0,
        totalCount: 0,
      }),
    ).toThrow();
  });
});


