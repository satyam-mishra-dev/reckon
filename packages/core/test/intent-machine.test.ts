import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  transition,
  type IntentEvent,
  type IntentEventType,
  type IntentState,
  type IntentStatus,
} from '../src/index.js';

// Every status × every event: 25 pairs, 8 legal, 17 illegal. The suite is
// generated from the full cross product so no pair can slip through untested.

const STATES: IntentState[] = [
  { status: 'created' },
  { status: 'processing' },
  { status: 'requires_retry' },
  { status: 'succeeded', providerRef: 'ch_prior' },
  { status: 'failed', failureCode: 'card_declined' },
];

const EVENTS: IntentEvent[] = [
  { type: 'PROVIDER_ACCEPTED', providerRef: 'ch_new' },
  { type: 'PROVIDER_DECLINED', failureCode: 'insufficient_funds' },
  { type: 'PROVIDER_TIMEOUT' },
  { type: 'RETRY_SCHEDULED' },
  { type: 'RETRY_EXHAUSTED' },
];

const LEGAL: Record<string, IntentStatus> = {
  'created:PROVIDER_ACCEPTED': 'succeeded',
  'created:PROVIDER_DECLINED': 'failed',
  'created:PROVIDER_TIMEOUT': 'requires_retry',
  'processing:PROVIDER_ACCEPTED': 'succeeded',
  'processing:PROVIDER_DECLINED': 'failed',
  'processing:PROVIDER_TIMEOUT': 'requires_retry',
  'requires_retry:RETRY_SCHEDULED': 'processing',
  'requires_retry:RETRY_EXHAUSTED': 'failed',
};

describe('transition — exhaustive over the full status × event cross product', () => {
  it('covers exactly 8 legal edges', () => {
    expect(Object.keys(LEGAL)).toHaveLength(8);
  });

  for (const state of STATES) {
    for (const event of EVENTS) {
      const edge = `${state.status}:${event.type}`;
      const expected = LEGAL[edge];

      if (expected !== undefined) {
        it(`allows ${state.status} + ${event.type} -> ${expected}`, () => {
          const next = transition(state, event);
          expect(next.status).toBe(expected);
          if (next.status === 'succeeded') {
            expect(next.providerRef).toBe('ch_new'); // payload carried from the event
          }
          if (next.status === 'failed' && event.type === 'PROVIDER_DECLINED') {
            expect(next.failureCode).toBe('insufficient_funds');
          }
          if (next.status === 'failed' && event.type === 'RETRY_EXHAUSTED') {
            expect(next.failureCode).toBe('retry_exhausted');
          }
        });
      } else {
        it(`rejects ${state.status} + ${event.type}`, () => {
          expect(() => transition(state, event)).toThrow(IllegalTransitionError);
          try {
            transition(state, event);
          } catch (err) {
            const illegal = err as IllegalTransitionError;
            expect(illegal.from).toBe(state.status);
            expect(illegal.event).toBe(event.type satisfies IntentEventType);
          }
        });
      }
    }
  }
});

describe('terminal states', () => {
  it('succeeded -> processing is impossible (no event reaches processing from succeeded)', () => {
    // RETRY_SCHEDULED is the only event whose target is `processing`.
    expect(() =>
      transition({ status: 'succeeded', providerRef: 'ch_x' }, { type: 'RETRY_SCHEDULED' }),
    ).toThrow(IllegalTransitionError);
  });

  it('no event leaves succeeded or failed', () => {
    for (const state of [
      { status: 'succeeded', providerRef: 'ch_x' },
      { status: 'failed', failureCode: 'card_declined' },
    ] satisfies IntentState[]) {
      for (const event of EVENTS) {
        expect(() => transition(state, event)).toThrow(IllegalTransitionError);
      }
    }
  });
});
