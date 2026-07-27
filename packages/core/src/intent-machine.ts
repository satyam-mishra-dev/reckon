// Payment-intent lifecycle as a pure state machine (brief §4.4). Zero I/O —
// the API layer persists the result and writes the outbox event in the same
// TX; this module only decides which edges exist.
//
// Legal edges (8):
//   created        --PROVIDER_ACCEPTED--> succeeded
//   created        --PROVIDER_DECLINED--> failed
//   created        --PROVIDER_TIMEOUT---> requires_retry
//   processing     --PROVIDER_ACCEPTED--> succeeded
//   processing     --PROVIDER_DECLINED--> failed
//   processing     --PROVIDER_TIMEOUT---> requires_retry
//   requires_retry --RETRY_SCHEDULED----> processing
//   requires_retry --RETRY_EXHAUSTED----> failed
//
// succeeded and failed are terminal. `processing` is entered only when a
// retry is picked back up: first attempts charge straight from `created`,
// which keeps every edge attributable to exactly one event.

export type IntentStatus = 'created' | 'processing' | 'requires_retry' | 'succeeded' | 'failed';

export type IntentState =
  | { status: 'created' }
  | { status: 'processing' }
  | { status: 'requires_retry' }
  | { status: 'succeeded'; providerRef: string }
  | { status: 'failed'; failureCode: string };

export type IntentEvent =
  | { type: 'PROVIDER_ACCEPTED'; providerRef: string }
  | { type: 'PROVIDER_DECLINED'; failureCode: string }
  | { type: 'PROVIDER_TIMEOUT' }
  | { type: 'RETRY_SCHEDULED' }
  | { type: 'RETRY_EXHAUSTED' };

export type IntentEventType = IntentEvent['type'];

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: IntentStatus,
    readonly event: IntentEventType,
  ) {
    super(`illegal intent transition: ${from} + ${event}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Returns the next state, or throws IllegalTransitionError for any edge not in the graph above. */
export function transition(state: IntentState, event: IntentEvent): IntentState {
  if (state.status === 'created' || state.status === 'processing') {
    switch (event.type) {
      case 'PROVIDER_ACCEPTED':
        return { status: 'succeeded', providerRef: event.providerRef };
      case 'PROVIDER_DECLINED':
        return { status: 'failed', failureCode: event.failureCode };
      case 'PROVIDER_TIMEOUT':
        return { status: 'requires_retry' };
      default:
        throw new IllegalTransitionError(state.status, event.type);
    }
  }
  if (state.status === 'requires_retry') {
    switch (event.type) {
      case 'RETRY_SCHEDULED':
        return { status: 'processing' };
      case 'RETRY_EXHAUSTED':
        return { status: 'failed', failureCode: 'retry_exhausted' };
      default:
        throw new IllegalTransitionError(state.status, event.type);
    }
  }
  // succeeded / failed: terminal — no event may leave them.
  throw new IllegalTransitionError(state.status, event.type);
}
