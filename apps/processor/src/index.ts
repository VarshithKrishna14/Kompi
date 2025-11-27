import { AnomalyDetector } from './anomaly-detector';
import { AlertDeduplicator, InMemoryDeduplicator, PostgresDeduplicator } from './deduplicator';
import { ComposioClient } from './packages/ai/src/composio-client';

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

  // Tool Router / MCP
  private composioClient!: ComposioClient;
  private mcpClient!: any;

  // Configuration
  private readonly FLUSH_INTERVAL_MS = 1000; // Check every second

  constructor() {
    // Initialize deduplicator
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      this.deduplicator = new PostgresDeduplicator(dbUrl);
    } else {
      console.log('Using in-memory deduplicator (no DATABASE_URL provided)');
      this.deduplicator = new InMemoryDeduplicator();
    }

    // Initialize anomaly detector
    this.detector = new AnomalyDetector({
      alpha: 0.1,
      minTrainingDataPoints: 10,
      spikeThresholdMultiplier: 5.0
    });

    // Initialize MCP for agentic actions
    const composioApiKey = process.env.COMPOSIO_API_KEY!;
    this.composioClient = new ComposioClient({
      apiKey: composioApiKey,
      userId: 'tracer-system',
      toolkits: ['slack', 'jira', 'pagerduty'],
    });

    this.initMCP().catch(err => console.error('Failed to initialize MCP:', err));
  }

  private async initMCP() {
    this.mcpClient = await this.composioClient.createMCPClient();
  }

  /**
   * Process a single log entry.
   */
  public async processLog(log: LogEntry): Promise<void> {
    const now = Date.now();

    // 1. Quick aggregation
    this.totalCount++;
    if (log.level === 'ERROR') {
      this.errorCount++;
    }

    // 2. Periodic flush to anomaly detector
    if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
      await this.flushMetrics(now);
    }

    // 3. Store log (Mock DB)
    // await db.insert('logs').values(log);
  }

  private async flushMetrics(now: number) {
    const timeDelta = now - this.lastFlushTime;
    if (timeDelta <= 0) return;

    const currentRate = (this.errorCount / timeDelta) * 1000;

    // Detect anomaly BEFORE training
    const result = this.detector.detect(currentRate);

    if (result.isAnomaly) {
      const alertKey = 'anomaly:global_error_rate';
      const shouldAlert = await this.deduplicator.shouldAlert(alertKey, 5);

      if (shouldAlert) {
        if (!this.mcpClient) {
          console.warn('[MCP NOT READY] ', result.details);
        } else {
          // Trigger alert via Tool Router MCP agent
          await this.mcpClient.callAgent({
            agentName: 'log-anomaly-alert-agent',
            input: `Anomaly detected! Details: ${result.details}, Value: ${result.metricValue.toFixed(2)}, Baseline: ${result.baselineMean.toFixed(2)}`
          });
        }
      } else {
        console.info(`[SUPPRESSED] Duplicate anomaly detected for ${alertKey}`);
      }
    }

    // Update the anomaly detector
    this.detector.train(currentRate);

    // Reset counters
    this.errorCount = 0;
    this.totalCount = 0;
    this.lastFlushTime = now;
  }
}

// Singleton instance if needed
export const logProcessor = new LogProcessor();
