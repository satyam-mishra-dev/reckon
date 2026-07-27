import { describe, expect, it } from 'vitest';
import { incCounter, observe, renderMetrics } from '../src/metrics.js';

describe('metrics registry', () => {
  it('renders labeled counters and cumulative histogram buckets', () => {
    incCounter('http_requests_total', { method: 'GET', route: '/healthz', status: '200' });
    incCounter('http_requests_total', { method: 'GET', route: '/healthz', status: '200' });
    observe('http_request_duration_ms', 3);
    observe('http_request_duration_ms', 700);

    const text = renderMetrics();
    expect(text).toContain('http_requests_total{method="GET",route="/healthz",status="200"} 2');
    expect(text).toContain('http_request_duration_ms_bucket{le="5"} 1'); // only the 3ms sample
    expect(text).toContain('http_request_duration_ms_bucket{le="1000"} 2'); // cumulative
    expect(text).toContain('http_request_duration_ms_bucket{le="+Inf"} 2');
    expect(text).toContain('http_request_duration_ms_sum 703');
    expect(text).toContain('http_request_duration_ms_count 2');
  });
});
