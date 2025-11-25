# Statistical Anomaly Detection System

A production-ready statistical anomaly detection system for observability platforms. Designed for high throughput (100,000+ logs/minute) with sub-10ms latency.

## Features

- **Z-Score Detection**: Statistical anomaly detection using z-scores with configurable thresholds
- **EWMA (Exponentially Weighted Moving Averages)**: Smooth tracking of metric trends
- **Spike Detection**: Catch sudden rate-of-change spikes (e.g., 5x increase in 60 seconds)
- **Regime Change Adaptation**: Automatically adapt baselines when metrics shift permanently
- **High Performance**: O(1) operations using Welford's algorithm and circular buffers
- **Edge Case Handling**: Robust handling of Infinity, NaN, and zero divisions
- **Persistence**: PostgreSQL storage for baselines and alerts using Drizzle ORM

## Installation

```bash
npm install
```

## Configuration

### Anomaly Detection Config

| Parameter | Default | Description |
|-----------|---------|-------------|
| `zScoreThreshold` | 3.0 | Z-score threshold for anomaly detection |
| `ewmaAlpha` | 0.3 | EWMA smoothing factor (0-1, higher = more recent weight) |
| `spikeWindowMs` | 60000 | Time window for spike detection (60 seconds) |
| `spikeMultiplier` | 5.0 | Spike ratio threshold (5x increase) |
| `minSampleCount` | 30 | Minimum samples before detection starts |
| `regimeChangeSensitivity` | 0.1 | Sensitivity to baseline shifts |
| `regimeWindowMs` | 300000 | Regime change detection window (5 minutes) |
| `maxWindowSize` | 10000 | Maximum samples in sliding window |

### Processor Config

| Parameter | Default | Description |
|-----------|---------|-------------|
| `databaseUrl` | env.DATABASE_URL | PostgreSQL connection string |
| `batchSize` | 100 | Batch size for database writes |
| `flushIntervalMs` | 1000 | Interval between flushes |
| `baselinePersistIntervalMs` | 60000 | Interval for baseline persistence |
| `errorRateWindowMs` | 60000 | Error rate calculation window |

## Usage

### Basic Usage

```typescript
import { createLogProcessor, LogProcessor } from '@opus-codex/processor';

// Create and initialize processor
const processor = await createLogProcessor({
  databaseUrl: 'postgresql://localhost:5432/observability',
  anomalyConfig: {
    zScoreThreshold: 3.0,
    spikeMultiplier: 5.0,
  },
});

// Process log entries
const result = processor.process({
  level: 'error',
  message: 'Database connection failed',
  service: 'api-gateway',
  metadata: { userId: '123' },
});

if (result.anomalyResult?.isAnomaly) {
  console.log('Anomaly detected:', result.anomalyResult.details);
}

// Graceful shutdown
await processor.shutdown();
```

### Direct Anomaly Detection

```typescript
import { AnomalyDetector, AnomalyDetectionManager } from '@opus-codex/processor';

// Single metric detector
const detector = new AnomalyDetector('error_rate:api-service', {
  zScoreThreshold: 2.5,
  minSampleCount: 20,
});

// Process values
const result = detector.process(0.05, Date.now());
console.log('Z-score:', result.zScore);
console.log('Is anomaly:', result.isAnomaly);

// Multiple metrics with manager
const manager = new AnomalyDetectionManager();

manager.onAlert((alert) => {
  console.log(`[${alert.severity}] ${alert.metricKey}: ${alert.result.details}`);
});

manager.process('service_a:error_rate', 0.02);
manager.process('service_b:latency', 150);
```

## Architecture

### Components

1. **AnomalyDetector**: Core detection class for a single metric
   - Uses Welford's online algorithm for numerically stable mean/variance
   - Circular buffer for efficient sliding window operations
   - O(1) time complexity for all operations

2. **AnomalyDetectionManager**: Manages multiple detectors
   - Automatic detector creation per metric
   - Alert callback system
   - Performance statistics tracking

3. **LogProcessor**: Full processing pipeline
   - Integrates with PostgreSQL via Drizzle ORM
   - Batch writes for efficiency
   - Automatic baseline persistence and recovery

### Database Schema

- `log_entries`: Processed log records with anomaly flags
- `error_rate_metrics`: Aggregated error rate metrics
- `baseline_states`: Persisted detector baselines
- `anomaly_alerts`: Alert history with acknowledgment tracking
- `metric_snapshots`: Recent metric values for recovery

## Testing

All tests are deterministic (no `Math.random()`):

```bash
# Run tests
npm test

# Run tests with coverage
npm run test -- --coverage

# Watch mode
npm run test:watch
```

## Performance

Designed to meet the following requirements:
- **Throughput**: 100,000+ logs per minute
- **Latency**: <10ms per operation
- **Memory**: O(maxWindowSize) per metric

Benchmarks on typical hardware:
- Single metric: ~0.01ms average per operation
- 100 concurrent metrics: ~0.02ms average per operation
- 100,000 operations: <5 seconds total

## Algorithm Details

### Welford's Online Algorithm

Used for numerically stable computation of running mean and variance:

```
n = n + 1
delta = x - mean
mean = mean + delta / n
delta2 = x - mean
M2 = M2 + delta * delta2
variance = M2 / (n - 1)
```

### EWMA (Exponentially Weighted Moving Average)

```
ewma_new = α * x + (1 - α) * ewma_old
```

Where α (alpha) is the smoothing factor. Higher α gives more weight to recent values.

### Z-Score Calculation

```
z = (x - μ) / σ
```

Where:
- x = current value
- μ = mean
- σ = standard deviation

Values with |z| > threshold (default 3.0) are flagged as anomalies.

### Spike Detection

Compares recent average to historical average within the spike window:

```
spike_ratio = recent_avg / historical_avg
```

If `spike_ratio >= spikeMultiplier` (default 5.0), a spike is detected.

## License

MIT

