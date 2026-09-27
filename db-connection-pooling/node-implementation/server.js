const express = require('express');
const client = require('@prometheus-io/client');
const DynamicPool = require('./DynamicPool');

const app = express();
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number.parseInt(process.env.DB_PORT || '5432')
};

// Initialize pool
const pool = new DynamicPool(dbConfig, 25, 30, 5000);

// Collect Node.js process defaults (CPU, heap memory, event loop lag, etc.)
client.collectDefaultMetrics();

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const route = req.route?.path || req.path;
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    httpRequestDuration.observe({
      method: req.method,
      route,
      status_code: String(res.statusCode)
    }, durationSeconds);
  });

  next();
});

// Metrics endpoint for Prometheus
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

// App endpoint
app.get('/heavy-query', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT pg_sleep(1.5)');
    res.send('Database query processed!');
  } catch (err) {
    pool.recordFailure('query');
    res.status(500).send('Database query failed.');
  } finally {
    pool.releaseConnection(conn);
  }
});

app.listen(3000, async () => {
  await pool.initializeBaseline();
  console.log('App & Metrics server running on http://localhost:3000');
});