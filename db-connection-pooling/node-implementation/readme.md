# Metrics Results

The following screenshots show the Prometheus and Grafana metrics collected while exercising the connection pool. This is tested to concurrent spikes and how db connections are maintained and served

In this experiment, I have tested results with custom implemented connection pool. I will have the results tested with library default algorithms in other experiments.

## Local Setup

Copy the environment template and replace the placeholder values with local credentials:

```bash
cp .env.example .env
```

Start the supporting services from this directory:

```bash
docker compose up -d
```

The `.env` file is intentionally ignored by Git. Do not commit real passwords or other secrets. This will only setup infra, install and start node js separately

## Results

### Request latency, throughput and connection pool wait queue metrics

![Metrics overview](metric_results/Screenshot%202026-09-27%20at%201.06.19%E2%80%AFPM.jpg)

### Same above metrics with visible http request failures with some connection pool size

![Metrics overview 2](metric_results/Screenshot%202026-09-27%20at%201.06.11%E2%80%AFPM.jpg)

### Node Health results

![Node Health results](metric_results/Screenshot%202026-09-27%20at%201.08.03%E2%80%AFPM.jpg)

## System Information
1. Database memory limit: 1 GB
2. Concurrent requests: 200
3. Query workload: a `SELECT` query with a fixed 1.5-second wait

## Observations
1. **A small pool created a clear queueing bottleneck.** With a maximum pool size of 2, requests spent more time waiting for an available connection. This configuration showed the highest pool wait-queue depth and the highest request latency.
2. **Increasing the pool size reduced request latency up to a point.** Larger pools allowed more queries to run concurrently and reduced time spent waiting for a connection. The latency improvement became small after approximately 30 connections, suggesting that the connection pool was no longer the primary bottleneck at that size.
3. **Throughput improved initially as the pool grew.** Throughput increased from below approximately 1.5 requests/second with a pool size of 2 to nearly 3 requests/second around a pool size of 30.
4. **More connections did not guarantee more throughput.** At pool sizes of approximately 45 to 60, throughput fell below 2.5 requests/second. This indicates that the database or the host was reaching a concurrency limit, so additional connections added contention or scheduling overhead instead of useful capacity.
5. **The largest pool caused connection failures.** With a pool size of 60, some requests failed with a `too many clients` error. The application served requests using the connections that were accepted, while other requests were rejected or failed. Therefore, the apparent throughput at this setting must be interpreted together with the failure count.
6. **The practical operating point was near 30 connections for this workload.** It provided the highest observed throughput with substantially lower latency and without the connection failures seen at 60. This is an experimental result, not a universal pool-size recommendation.
7. **Queue depth is an early saturation signal.** A rising wait queue means incoming work is arriving faster than the current pool can obtain and service connections. It can be used to determine as one of indicator to identify how server is able to server clients, and what is the bottleneck.
8. **The fixed query delay limits the conclusions.** Because every query waits 1.5 seconds, these results mainly describe connection concurrency and queueing behavior. A production workload with different query durations, transactions, indexes, or mixed read/write traffic may have a different optimal pool size.


## Conclusion

For this workload, increasing the connection pool from 2 to approximately 30 connections **improved throughput and substantially reduced request latency** by reducing connection wait time. Increasing the pool beyond that point provided no additional benefit and eventually reduced throughput because the database reached its connection capacity, producing `too many clients` failures at a pool size of 60.

The results suggest that the best pool size is the point where throughput is highest, latency has stabilized, and failures remain at zero or within an acceptable limit. For this experiment, that point was approximately 30 connections. The value should be treated as a workload-specific starting point and validated with production-like traffic, database resource metrics, p95/p99 latency, queue depth, and request failure rates.

Implementing a database connection pool is essential for maintaining optimal system performance. Without it, the overhead of repeatedly creating and closing connections will severely degrade performance.