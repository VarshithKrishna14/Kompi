export interface AnomalyDetectionConfig {
  alpha: number; // Smoothing factor for EWMA (0 < alpha <= 1)
  zScoreThreshold: number;
  minTrainingDataPoints: number; // Minimum points before flagging anomalies
  spikeThresholdMultiplier: number; // e.g., 5x increase
}

export interface AnomalyResult {
  isAnomaly: boolean;
  score: number; // Z-score
  details: string;
  metricValue: number;
  baselineMean: number;
  baselineStdDev: number;
}

export class AnomalyDetector {
  private mean: number = 0;
  private variance: number = 0;
  private stdDev: number = 0;
  private count: number = 0;
  private previousValue: number | null = null;
  
  private config: AnomalyDetectionConfig;

  constructor(config: Partial<AnomalyDetectionConfig> = {}) {
    this.config = {
      alpha: 0.1,
      zScoreThreshold: 3.0,
      minTrainingDataPoints: 30,
      spikeThresholdMultiplier: 5.0,
      ...config
    };
    
    this.validateConfig();
  }

  private validateConfig() {
    if (this.config.alpha <= 0 || this.config.alpha > 1) {
      throw new Error("Alpha must be between 0 and 1");
    }
  }

  /**
   * Updates the baseline model with a new data point.
   * Should be called periodically (e.g., every minute) with aggregated rates.
   */
  public train(value: number): void {
    if (!this.isValid(value)) return;

    // First point initialization
    if (this.count === 0) {
      this.mean = value;
      this.variance = 0;
      this.stdDev = 0;
      this.count++;
      this.previousValue = value;
      return;
    }

    const alpha = this.config.alpha;
    const diff = value - this.mean;
    const incr = alpha * diff;
    
    // Update Mean: EWMA
    this.mean = this.mean + incr;

    // Update Variance: EWMA
    // Var(t) = (1-alpha) * (Var(t-1) + alpha * (X(t) - Mean(t-1))^2)
    // Approximation for online running variance
    this.variance = (1 - alpha) * (this.variance + alpha * diff * diff);
    this.stdDev = Math.sqrt(this.variance);

    this.count++;
    this.previousValue = value;
  }

  /**
   * Checks if the given value is an anomaly based on current baseline.
   * Does NOT update the internal model (use train() for that).
   */
  public detect(value: number): AnomalyResult {
    if (!this.isValid(value)) {
       return this.createResult(false, 0, "Invalid input (NaN/Infinity)", value);
    }

    // Not enough data yet
    if (this.count < this.config.minTrainingDataPoints) {
      return this.createResult(false, 0, "Insufficient training data", value);
    }

    // 1. Check Rate of Change Spike
    // Avoid division by zero by using a small epsilon if previous is 0
    // But logically, if prev is 0 and current is 100, that's a huge spike.
    // If prev is 0, we can treat it as a small number like 0.1 for ratio calculation if metrics are counts.
    if (this.previousValue !== null) {
        const prev = Math.max(this.previousValue, 0.000001); 
        const ratio = value / prev;
        
        if (ratio >= this.config.spikeThresholdMultiplier && value > this.mean) {
             return this.createResult(true, ratio, `Rate spike detected: ${ratio.toFixed(1)}x increase`, value);
        }
    }

    // 2. Check Z-Score
    // Handle zero variance edge case
    if (this.stdDev === 0) {
        if (value === this.mean) {
            return this.createResult(false, 0, "Matches constant baseline", value);
        } else {
             // If variance is 0, ANY deviation is technically infinite Z-score.
             // We'll treat it as anomaly if it differs significantly from mean (relative or absolute).
             // For safety, if value != mean and var=0, it's an anomaly.
             return this.createResult(true, Infinity, "Deviation from zero-variance baseline", value);
        }
    }

    const zScore = (value - this.mean) / this.stdDev;
    
    if (Math.abs(zScore) > this.config.zScoreThreshold) {
        return this.createResult(true, zScore, `Z-score threshold exceeded: ${zScore.toFixed(2)}`, value);
    }

    return this.createResult(false, zScore, "Normal", value);
  }

  private isValid(value: number): boolean {
    return typeof value === 'number' && isFinite(value) && !isNaN(value);
  }

  private createResult(isAnomaly: boolean, score: number, details: string, value: number): AnomalyResult {
    return {
      isAnomaly,
      score,
      details,
      metricValue: value,
      baselineMean: this.mean,
      baselineStdDev: this.stdDev
    };
  }

  public getStats() {
    return {
      mean: this.mean,
      stdDev: this.stdDev,
      count: this.count,
      variance: this.variance
    };
  }

  public serialize(): string {
    return JSON.stringify({
      mean: this.mean,
      variance: this.variance,
      count: this.count,
      previousValue: this.previousValue
    });
  }

  public static hydrate(state: string, config?: Partial<AnomalyDetectionConfig>): AnomalyDetector {
    const data = JSON.parse(state);
    const detector = new AnomalyDetector(config);
    detector.mean = data.mean;
    detector.variance = data.variance;
    detector.stdDev = Math.sqrt(data.variance);
    detector.count = data.count;
    detector.previousValue = data.previousValue;
    return detector;
  }
}

