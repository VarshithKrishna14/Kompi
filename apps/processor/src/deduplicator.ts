import postgres from 'postgres';

export interface AlertDeduplicator {
  /**
   * Checks if an alert should be sent for the given key.
   * If true, it updates the state to prevent duplicate alerts for the duration of the window.
   * @param key Unique identifier for the alert (e.g. "service-a:high-error-rate")
   * @param windowSeconds Duration in seconds to suppress duplicates
   */
  shouldAlert(key: string, windowSeconds: number): Promise<boolean>;
}

export class PostgresDeduplicator implements AlertDeduplicator {
  private sql: postgres.Sql;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      // Production settings for resilience
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  async shouldAlert(key: string, windowSeconds: number): Promise<boolean> {
    try {
      // We use NOW() from the database to handle clock skew between processors.
      // The logic:
      // 1. Try to insert. If successful, it's a new alert -> Return true.
      // 2. If conflict, try to update ONLY IF enough time has passed.
      // 3. If update happens, it means we re-armed the alert -> Return true.
      // 4. If no update happens (because of WHERE clause), it's a duplicate -> Return false.
      
      const result = await this.sql`
        INSERT INTO alert_deduplication (alert_key, last_fired_at)
        VALUES (${key}, NOW())
        ON CONFLICT (alert_key)
        DO UPDATE SET
          last_fired_at = NOW()
        WHERE alert_deduplication.last_fired_at <= NOW() - (${windowSeconds} || ' seconds')::interval
        RETURNING last_fired_at
      `;

      return result.length > 0;
    } catch (error) {
      // Fail open or closed?
      // In monitoring, failing open (sending duplicate alerts) is usually better than missing alerts.
      // However, if DB is down, we might flood. 
      // Let's log error and fail open (allow alert) but maybe with rate limiting in a real system.
      // For now, we'll log and return true to be safe.
      console.error('Error in deduplication logic:', error);
      return true;
    }
  }

  async close() {
    await this.sql.end();
  }
}

// Mock implementation for testing or local dev without DB
export class InMemoryDeduplicator implements AlertDeduplicator {
  private locks = new Map<string, number>();

  async shouldAlert(key: string, windowSeconds: number): Promise<boolean> {
    const now = Date.now();
    const lastFired = this.locks.get(key);

    if (lastFired && (now - lastFired) < windowSeconds * 1000) {
      return false;
    }

    this.locks.set(key, now);
    return true;
  }
}

