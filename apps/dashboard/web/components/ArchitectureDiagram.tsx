import type { ReactNode } from 'react';

// The README Mermaid flowchart, hand-rendered to the §2.2 tokens (bundled SVG —
// no mermaid runtime, no CDN). Same topology: client → API (idempotency →
// intents → ledger/outbox) → worker → provider-sim / webhooks → receiver, with
// the reconciler auditing ledger ⟷ provider, and the dashboard reading /v1.

type Side = 'top' | 'bottom' | 'left' | 'right';
interface Node {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  accent?: 'debit' | 'credit' | 'action' | 'hold';
}

const NODES: Node[] = [
  { id: 'client', x: 372, y: 12, w: 116, h: 38, title: 'Client' },
  { id: 'dash', x: 150, y: 78, w: 150, h: 38, title: 'Dashboard', sub: '+ playground' },
  { id: 'api', x: 356, y: 78, w: 148, h: 38, title: 'API', sub: 'Fastify' },
  { id: 'reads', x: 150, y: 158, w: 130, h: 48, title: 'Read models', sub: '/v1', accent: 'action' },
  { id: 'idem', x: 322, y: 158, w: 122, h: 48, title: 'Idempotency', sub: 'keys · recovery points' },
  { id: 'intents', x: 322, y: 220, w: 122, h: 48, title: 'Payment intents', sub: 'state machine' },
  { id: 'ledger', x: 462, y: 158, w: 122, h: 48, title: 'Ledger', sub: 'double-entry', accent: 'credit' },
  { id: 'outbox', x: 462, y: 220, w: 122, h: 48, title: 'Outbox', sub: 'events · same TX' },
  { id: 'recon', x: 626, y: 189, w: 140, h: 48, title: 'Reconciler', sub: 'proves zero drift', accent: 'action' },
  { id: 'worker', x: 356, y: 300, w: 148, h: 44, title: 'Worker', sub: 'job queue · SKIP LOCKED' },
  { id: 'provider', x: 138, y: 384, w: 154, h: 48, title: 'Provider-sim', sub: 'deliberately unreliable', accent: 'hold' },
  { id: 'webhooks', x: 356, y: 384, w: 154, h: 48, title: 'Webhooks', sub: 'HMAC · backoff · DLQ' },
  { id: 'receiver', x: 372, y: 466, w: 116, h: 38, title: 'Receiver' },
];

interface Edge {
  from: string;
  fromSide: Side;
  to: string;
  toSide: Side;
  bidir?: boolean;
  label?: string;
}

const EDGES: Edge[] = [
  { from: 'client', fromSide: 'bottom', to: 'api', toSide: 'top' },
  { from: 'dash', fromSide: 'bottom', to: 'reads', toSide: 'top' },
  { from: 'reads', fromSide: 'right', to: 'idem', toSide: 'left' },
  { from: 'api', fromSide: 'bottom', to: 'idem', toSide: 'top' },
  { from: 'idem', fromSide: 'bottom', to: 'intents', toSide: 'top' },
  { from: 'intents', fromSide: 'right', to: 'ledger', toSide: 'left' },
  { from: 'intents', fromSide: 'right', to: 'outbox', toSide: 'left' },
  { from: 'ledger', fromSide: 'right', to: 'recon', toSide: 'left', bidir: true },
  { from: 'outbox', fromSide: 'bottom', to: 'worker', toSide: 'top', label: 'poll' },
  { from: 'worker', fromSide: 'left', to: 'provider', toSide: 'top' },
  { from: 'worker', fromSide: 'bottom', to: 'webhooks', toSide: 'top' },
  { from: 'webhooks', fromSide: 'bottom', to: 'receiver', toSide: 'top' },
  { from: 'recon', fromSide: 'bottom', to: 'provider', toSide: 'right', bidir: true },
];

const byId = new Map(NODES.map((n) => [n.id, n]));
function anchor(id: string, side: Side): [number, number] {
  const n = byId.get(id);
  if (!n) return [0, 0];
  switch (side) {
    case 'top':
      return [n.x + n.w / 2, n.y];
    case 'bottom':
      return [n.x + n.w / 2, n.y + n.h];
    case 'left':
      return [n.x, n.y + n.h / 2];
    case 'right':
      return [n.x + n.w, n.y + n.h / 2];
  }
}

const ACCENT: Record<NonNullable<Node['accent']>, string> = {
  debit: 'var(--color-debit)',
  credit: 'var(--color-credit)',
  action: 'var(--color-action)',
  hold: 'var(--color-hold)',
};

export function ArchitectureDiagram(): ReactNode {
  return (
    <svg
      viewBox="0 0 780 516"
      role="img"
      aria-label="Tally architecture: client to API through idempotency, payment intents, ledger and outbox; a worker drives the provider-sim and webhook dispatcher to the receiver; a reconciler audits the ledger against the provider; the dashboard reads the v1 API."
      className="h-auto w-full"
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--color-ink-60)" />
        </marker>
      </defs>

      {/* apps/api group */}
      <rect x={306} y={140} width={296} height={144} rx={4} fill="none" stroke="var(--color-rule)" strokeDasharray="3 3" />
      <text x={312} y={135} fontFamily="var(--font-mono)" fontSize={10} fill="var(--color-ink-45)">
        apps/api
      </text>

      {EDGES.map((e, i) => {
        const [x1, y1] = anchor(e.from, e.fromSide);
        const [x2, y2] = anchor(e.to, e.toSide);
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        return (
          <g key={i}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--color-ink-60)"
              strokeWidth={1}
              markerEnd="url(#arrow)"
              markerStart={e.bidir ? 'url(#arrow)' : undefined}
            />
            {e.label ? (
              <text x={mx + 4} y={my - 2} fontFamily="var(--font-mono)" fontSize={9} fill="var(--color-ink-45)">
                {e.label}
              </text>
            ) : null}
          </g>
        );
      })}

      {NODES.map((n) => (
        <g key={n.id}>
          <rect
            x={n.x}
            y={n.y}
            width={n.w}
            height={n.h}
            rx={4}
            fill="var(--color-paper)"
            stroke={n.accent ? ACCENT[n.accent] : 'var(--color-rule)'}
            strokeWidth={n.accent ? 1.4 : 1}
          />
          <text
            x={n.x + n.w / 2}
            y={n.sub ? n.y + n.h / 2 - 3 : n.y + n.h / 2 + 4}
            textAnchor="middle"
            fontFamily="var(--font-sans)"
            fontSize={12}
            fontWeight={600}
            fill="var(--color-ink)"
          >
            {n.title}
          </text>
          {n.sub ? (
            <text
              x={n.x + n.w / 2}
              y={n.y + n.h / 2 + 12}
              textAnchor="middle"
              fontFamily="var(--font-mono)"
              fontSize={9}
              fill="var(--color-ink-45)"
            >
              {n.sub}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}
