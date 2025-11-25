import { AnomalyDetector } from './anomaly-detector';
import { AlertDeduplicator, InMemoryDeduplicator, PostgresDeduplicator } from './deduplicator';

// Mock types for context
interface LogEntry {
  timestamp: Date;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  serviceId: string;
}

// Mock DB client
const db = {
  insert: (table: any) => ({
    values: (data: any) => Promise.resolve()
  })
};

export class LogProcessor {
  private detector: AnomalyDetector;
  private deduplicator: AlertDeduplicator;
  private errorCount: number = 0;
  private totalCount: number = 0;
  private lastFlushTime: number = Date.now();
  
  // Configuration
  private readonly FLUSH_INTERVAL_MS = 1000; // Check every second

  constructor() {
    // Initialize deduplicator
    // In production, we would use PostgresDeduplicator with a real connection string
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      this.deduplicator = new PostgresDeduplicator(dbUrl);
    } else {
      console.log('Using in-memory deduplicator (no DATABASE_URL provided)');
      this.deduplicator = new InMemoryDeduplicator();
    }

    // In a real app, we would load the serialized model state from DB/Redis here
    // const savedState = await db.query.anomaly_models.findFirst(...)
    // if (savedState) {
    //   this.detector = AnomalyDetector.hydrate(savedState.json, { ... });
    // } else {
      this.detector = new AnomalyDetector({
        alpha: 0.1, // Adapt relatively quickly
        minTrainingDataPoints: 10,
        spikeThresholdMultiplier: 5.0
      });
    // }
    
    // Start the flush loop if this were a real long-running process
    // For this implementation, we'll rely on checkFlush() being called on ingest
    // or an external timer.
  }

  /**
   * Process a single log entry.
   * optimized for high throughput (>100k/min).
   */
  public async processLog(log: LogEntry): Promise<void> {
    const now = Date.now();

    // 1. Quick aggregation
    this.totalCount++;
    if (log.level === 'ERROR') {
      this.errorCount++;
    }

    // 2. Periodic flush to anomaly detector
    // We check on every log if it's time to flush. 
    // This is low overhead (simple comparison).
    if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
      await this.flushMetrics(now);
    }
    
    // 3. Store log (Mock DB)
    // In production, this would likely be batched as well
    // await db.insert('logs').values(log); 
  }

  private async flushMetrics(now: number) {
    const timeDelta = now - this.lastFlushTime;
    if (timeDelta <= 0) return;

    // Calculate error rate (errors per second)
    // We normalize to "per second" to be consistent regardless of jitter in flush timing
    const currentRate = (this.errorCount / timeDelta) * 1000;

    // Detect Anomaly BEFORE training (so we don't pollute baseline with the anomaly immediately if we want to alert first)
    // However, for regime adaptation, we DO want to train on it eventually.
    // Standard practice: Detect -> Alert -> Train
    
    const result = this.detector.detect(currentRate);
    
    if (result.isAnomaly) {
      // Deduplicate alerts
      // Key: unique identifier for this type of anomaly. 
      // If we had multiple services, we'd include the serviceId in the key.
      const alertKey = 'anomaly:global_error_rate';
      const shouldAlert = await this.deduplicator.shouldAlert(alertKey, 5);

      if (shouldAlert) {
        console.warn(`[ANOMALY DETECTED] ${result.details} (Value: ${result.metricValue.toFixed(2)}, Baseline: ${result.baselineMean.toFixed(2)})`);
        
        // Here we would trigger alerts, webhooks, etc.
        // await sendAlert(result);
      } else {
        console.info(`[SUPPRESSED] Duplicate anomaly detected for ${alertKey}`);
      }
    }

    // Update the model
    // We might choose NOT to train on extreme anomalies to avoid polluting the baseline
    // But requirement says "Adapt to regime changes", so we MUST train even on anomalies 
    // eventually, or use a separate "long term" baseline.
    // With EWMA, training on anomalies allows the baseline to shift up to the new "normal" (regime change).
    this.detector.train(currentRate);

    // Reset counters
    this.errorCount = 0;
    this.totalCount = 0;
    this.lastFlushTime = now;
  }
}

// Singleton instance if needed
export const logProcessor = new LogProcessor();

