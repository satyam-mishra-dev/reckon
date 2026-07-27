// Homegrown metrics: counters + one fixed-bucket histogram shape, rendered as
// Prometheus-style text. Deliberately not prom-client — a few Maps is all the
// brief's /metrics endpoint needs.

type Labels = Record<string, string>;

const counters = new Map<string, number>(); // serialized "name{labels}" -> value
const counterNames = new Set<string>();

function serialize(name: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${labels[key]}"`);
  return parts.length > 0 ? `${name}{${parts.join(',')}}` : name;
}

export function incCounter(name: string, labels: Labels = {}, by = 1): void {
  counterNames.add(name);
  const key = serialize(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

const BUCKET_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];

interface Histogram {
  counts: number[]; // per-bucket (non-cumulative); made cumulative at render
  sum: number;
  count: number;
}

const histograms = new Map<string, Histogram>();

export function observe(name: string, value: number): void {
  let h = histograms.get(name);
  if (h === undefined) {
    h = { counts: BUCKET_BOUNDS_MS.map(() => 0), sum: 0, count: 0 };
    histograms.set(name, h);
  }
  h.sum += value;
  h.count += 1;
  const index = BUCKET_BOUNDS_MS.findIndex((bound) => value <= bound);
  if (index >= 0) {
    h.counts[index] = (h.counts[index] ?? 0) + 1;
  }
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const name of [...counterNames].sort()) {
    lines.push(`# TYPE ${name} counter`);
    const matching = [...counters.entries()]
      .filter(([key]) => key === name || key.startsWith(`${name}{`))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of matching) {
      lines.push(`${key} ${value}`);
    }
  }
  for (const [name, h] of [...histograms.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`# TYPE ${name} histogram`);
    let cumulative = 0;
    BUCKET_BOUNDS_MS.forEach((bound, i) => {
      cumulative += h.counts[i] ?? 0;
      lines.push(`${name}_bucket{le="${bound}"} ${cumulative}`);
    });
    lines.push(`${name}_bucket{le="+Inf"} ${h.count}`);
    lines.push(`${name}_sum ${h.sum}`);
    lines.push(`${name}_count ${h.count}`);
  }
  return lines.join('\n') + '\n';
}
