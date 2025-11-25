import assert from 'assert';
import { AnomalyDetector } from '../anomaly-detector';

async function runTests() {
  console.log('Running AnomalyDetector Tests...');

  // Helper to feed data
  function feed(detector: AnomalyDetector, values: number[]) {
      values.forEach(v => detector.train(v));
  }

  // Test 1: Initialization and Basic Learning
  {
      console.log('Test 1: Initialization and Basic Learning');
      const detector = new AnomalyDetector({ minTrainingDataPoints: 5 });
      
      // Train with constant values
      feed(detector, [10, 10, 10, 10, 10]);
      
      const stats = detector.getStats();
      assert.strictEqual(stats.mean, 10, 'Mean should be 10');
      assert.strictEqual(stats.stdDev, 0, 'StdDev should be 0');
      
      const result = detector.detect(10);
      assert.strictEqual(result.isAnomaly, false);
      assert.strictEqual(result.score, 0);
  }

  // Test 2: Z-Score Anomaly
  {
      console.log('Test 2: Z-Score Anomaly');
      const detector = new AnomalyDetector({ 
          minTrainingDataPoints: 10, 
          alpha: 0.1,
          zScoreThreshold: 3 
      });
      
      // Train with some variance
      // 10, 12, 10, 8, 10...
      const data = Array(20).fill(10).map((v, i) => v + (i % 2 === 0 ? 1 : -1));
      feed(detector, data);
      
      // Stats should have mean ~10 and some stdDev
      const stats = detector.getStats();
      assert(Math.abs(stats.mean - 10) < 1, 'Mean should be close to 10');
      assert(stats.stdDev > 0, 'StdDev should be > 0');
      
      // Test outlier
      const outlier = 20; // Massive jump
      const result = detector.detect(outlier);
      
      assert.strictEqual(result.isAnomaly, true, 'Should detect 20 as anomaly');
      assert(result.score > 3, 'Z-score should be > 3');
  }

  // Test 3: Rate of Change Spike
  {
      console.log('Test 3: Rate of Change Spike');
      const detector = new AnomalyDetector({ 
          spikeThresholdMultiplier: 5,
          minTrainingDataPoints: 1 
      });
      
      detector.train(10);
      
      // Next value 60 (6x increase)
      const result = detector.detect(60);
      assert.strictEqual(result.isAnomaly, true, 'Should detect spike');
      assert(result.details.includes('Rate spike'), 'Reason should be rate spike');
  }

  // Test 4: Regime Change Adaptation
  {
      console.log('Test 4: Regime Change Adaptation');
      const detector = new AnomalyDetector({ 
          alpha: 0.5, // Fast adaptation
          minTrainingDataPoints: 5,
          zScoreThreshold: 2
      });
      
      // Regime 1: Mean 10
      feed(detector, [10, 10, 10, 10, 10, 10]);
      
      // Sudden shift to 50
      const anomaly = detector.detect(50);
      assert.strictEqual(anomaly.isAnomaly, true, 'First 50 should be anomaly');
      
      // Train on new regime
      feed(detector, [50, 50, 50, 50, 50]);
      
      // Now 50 should be normal
      const normal = detector.detect(50);
      assert.strictEqual(normal.isAnomaly, false, '50 should be normal after adaptation');
      assert(Math.abs(detector.getStats().mean - 50) < 1, 'Mean should have shifted to ~50');
  }

  // Test 5: Edge Cases
  {
      console.log('Test 5: Edge Cases');
      const detector = new AnomalyDetector();
      
      const resNaN = detector.detect(NaN);
      assert.strictEqual(resNaN.isAnomaly, false); // Ignored or handled gracefully
      
      const resInf = detector.detect(Infinity);
      assert.strictEqual(resInf.isAnomaly, false);
      
      detector.train(NaN); // Should not break state
      detector.train(Infinity);
      
      const stats = detector.getStats();
      assert(!isNaN(stats.mean));
      assert(isFinite(stats.mean));
  }

  console.log('All tests passed!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

