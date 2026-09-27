const { Client } = require('pg');
const client = require('@prometheus-io/client');

class DynamicPool {
  constructor(dbConfig, min = 2, max = 5, idleTimeoutMs = 5000) {
    this.dbConfig = dbConfig;
    this.min = min;
    this.max = max;
    this.idleTimeoutMs = idleTimeoutMs;
    
    this.pool = [];
    this.totalConnections = 0;
    this.waitQueue = [];

    // Background reaper for scale-down
    this.reaperInterval = setInterval(() => this.reapIdleConnections(), 2000);

    // Register Prometheus telemetry
    this._registerMetrics();
  }

  _registerMetrics() {
    const pool = this;
    this.metrics = {
      total: new client.Gauge({
        name: 'custom_pool_total',
        help: 'Total database connections managed by the pool',
        collect() {
          this.set(pool.totalConnections);
        }
      }),
      active: new client.Gauge({
        name: 'custom_pool_active',
        help: 'Active executing connections',
        collect() {
          this.set(pool.totalConnections - pool.pool.length);
        }
      }),
      idle: new client.Gauge({
        name: 'custom_pool_idle',
        help: 'Free connections sitting in RAM',
        collect() {
          this.set(pool.pool.length);
        }
      }),
      queued: new client.Gauge({
        name: 'custom_pool_wait_queue',
        help: 'App requests blocked and waiting',
        collect() {
          this.set(pool.waitQueue.length);
        }
      }),
      failures: new client.Counter({
        name: 'custom_pool_failures_total',
        help: 'Database pool operation failures',
        labelNames: ['type']
      }),
      queueWait: new client.Histogram({
        name: 'custom_pool_queue_wait_duration_seconds',
        help: 'Time requests wait for a database connection',
        buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5],
      }),
      idleDuration: new client.Histogram({
        name: 'custom_pool_connection_idle_duration_seconds',
        help: 'Time connections remain idle before being checked out',
        buckets: [0.01, 0.1, 0.5, 1, 2, 5, 10],
      }),
      usageDuration: new client.Histogram({
        name: 'custom_pool_connection_usage_duration_seconds',
        help: 'Time connections remain checked out by a request',
        buckets: [0.01, 0.1, 0.5, 1, 2, 5, 10],
      })
    };
  }

  recordFailure(type) {
    this.metrics.failures.inc({ type });
  }

  async _createNewConnection() {
    const conn = new Client(this.dbConfig);
    try {
      await conn.connect();
    } catch (err) {
      this.recordFailure('connection');
      throw err;
    }
    conn.id = Math.random().toString(36).substring(7);
    return conn;
  }

  async initializeBaseline() {
    console.log(`[BOOT] Opening ${this.min} baseline connections.`);
    for (let i = 0; i < this.min; i++) {
      const conn = await this._createNewConnection();
      conn.lastUsed = Date.now();
      this.pool.push(conn);
      this.totalConnections++;
    }
  }

  async getConnection() {
    if (this.pool.length > 0) {
      const connection = this.pool.pop();
      this.metrics.idleDuration.observe((Date.now() - connection.lastUsed) / 1000);
      connection.checkedOutAt = process.hrtime.bigint();
      return connection;
    }

    if (this.totalConnections < this.max) {
      this.totalConnections++;
      console.log(`[SCALE UP] Max ${this.max}. Expanding to ${this.totalConnections}`);
      const connection = await this._createNewConnection();
      connection.checkedOutAt = process.hrtime.bigint();
      return connection;
    }

    console.log(`[QUEUE] Max limit hit. Request queued.`);
    return new Promise(resolve => this.waitQueue.push({ resolve, queuedAt: process.hrtime.bigint() }));
  }

  releaseConnection(conn) {
    if (this.waitQueue.length > 0) {
      const nextRequest = this.waitQueue.shift();
      const queueWaitSeconds = Number(process.hrtime.bigint() - nextRequest.queuedAt) / 1e9;
      this.metrics.queueWait.observe(queueWaitSeconds);
      conn.checkedOutAt = process.hrtime.bigint();
      nextRequest.resolve(conn);
      return;
    }
    if (conn.checkedOutAt) {
      const usageSeconds = Number(process.hrtime.bigint() - conn.checkedOutAt) / 1e9;
      this.metrics.usageDuration.observe(usageSeconds);
      delete conn.checkedOutAt;
    }
    conn.lastUsed = Date.now();
    this.pool.push(conn);
  }

  reapIdleConnections() {
    const now = Date.now();
    for (let i = this.pool.length - 1; i >= 0; i--) {
      if (this.totalConnections > this.min) {
        const conn = this.pool[i];
        if (now - conn.lastUsed > this.idleTimeoutMs) {
          console.log(`[SCALE DOWN] Closing idle connection ${conn.id}`);
          conn.end();
          this.pool.splice(i, 1);
          this.totalConnections--;
        }
      }
    }
  }
}

module.exports = DynamicPool;