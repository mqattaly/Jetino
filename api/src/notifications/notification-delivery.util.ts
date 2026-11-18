export type DeliveryChannel = 'IN_APP' | 'PUSH';
export type DeliveryState = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['IN_APP', 'PUSH'];
export const DELIVERY_STATES: readonly DeliveryState[] = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'];

/** A delivery stops being retried after this many attempts; the row stays visible as FAILED. */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** A push subscription is deactivated after this many permanent-looking failures. */
export const MAX_PUSH_FAILURES = 8;
/** Seconds to wait before retry n (index 0 = first retry after the initial attempt). */
export const DELIVERY_BACKOFF_SECONDS = [30, 120, 600, 1800] as const;
/** Rows one dispatch pass may claim; a scheduler calling every minute must not be able to grow the batch. */
export const DISPATCH_BATCH_LIMIT = 50;
export const PUSH_CRON_HEADER = 'authorization';
/** How long a claimed row is leased before another worker may take it again. */
export const DISPATCH_LEASE_SECONDS = 120;

export function leaseIntervalSql(): string {
  return `interval '${DISPATCH_LEASE_SECONDS} seconds'`;
}
export const PUSH_NOT_CONFIGURED = 'push-not-configured';
/** Explicit opt-in used by the integration drill; production installs stay on the provider. */
export const LOCAL_PUSH_FLAG = 'JETINO_ALLOW_LOCAL_PUSH';

export interface DeliveryRow {
  notificationId: string;
  userId: string;
  channel: DeliveryChannel;
  subscriptionId: string | null;
}

export interface DispatchPlanInput {
  userIds: readonly string[];
  pushConfigured: boolean;
}

// version nibble in the third group, RFC 4122 variant in the fourth — same shape the JWT guard uses
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUSH_KEY_RE = /^[A-Za-z0-9_-]{16,255}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isPushKey(value: unknown): value is string {
  return typeof value === 'string' && PUSH_KEY_RE.test(value);
}

/** Dedupe keys are operator-visible, so they stay short and free of whitespace. */
export function normalizeDedupeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 160);
}

export function uniqueIds(userIds: readonly string[]): string[] {
  return [...new Set(userIds.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

/**
 * The plan is a pure function so both facts the PRD asks for are testable without a database:
 * one row per recipient per channel (no duplicates, no gaps) and no push rows at all when the
 * VAPID keys are missing — an unconfigured channel must never pretend to have delivered.
 */
export function buildDeliveryPlan(notificationId: string, input: DispatchPlanInput): DeliveryRow[] {
  const rows: DeliveryRow[] = [];
  for (const userId of uniqueIds(input.userIds)) {
    rows.push({ notificationId, userId, channel: 'IN_APP', subscriptionId: null });
    if (input.pushConfigured) rows.push({ notificationId, userId, channel: 'PUSH', subscriptionId: null });
  }
  return rows;
}

export function backoffSecondsFor(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return DELIVERY_BACKOFF_SECONDS[0];
  return DELIVERY_BACKOFF_SECONDS[Math.min(attempt - 1, DELIVERY_BACKOFF_SECONDS.length - 1)];
}

/** How long a delivery has to live before the retry that follows `attempt` runs. */
export function retryDelaySql(attempt: number): string {
  return `interval '${backoffSecondsFor(attempt)} seconds'`;
}

export function truncateError(value: string | null | undefined, max = 300): string | null {
  if (!value) return null;
  const single = value.replace(/\s+/g, ' ').trim();
  if (!single) return null;
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * Event targeting (§7.12). Groups, not raw event types, because that is what a person can decide
 * on; the service expands a group into the event types it covers. An unknown key is refused rather
 * than ignored, so a typo in the UI can never look like a working preference.
 */
export const PUSH_EVENT_GROUPS = {
  ORDER_STATUS: ['ORDER_CONFIRMED', 'ORDER_PREPARING', 'ORDER_READY_FOR_PICKUP', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'ORDER_REJECTED'],
  ORDER_CANCELLATION: ['ORDER_CANCELLED', 'ORDER_CANCELLATION_DECIDED', 'ORDER_REFUNDED'],
  DELIVERY: ['ORDER_DRIVER_ASSIGNED', 'DELIVERY_ASSIGNED'],
  FEEDBACK: ['ORDER_FEEDBACK', 'DRIVER_FEEDBACK'],
  SUPPORT: ['SUPPORT_TICKET_OPENED', 'SUPPORT_TICKET_MESSAGE', 'SUPPORT_TICKET_RESOLVED'],
  SETTLEMENT: ['CASH_PAYMENT_CONFIRMED', 'CASH_SETTLED'],
  SHOP: ['ORDER_NEW', 'ORDER_CANCELLATION_REQUEST', 'ORDER_CANCELLATION_REVIEW'],
} as const satisfies Record<string, readonly string[]>;

export type PushEventGroup = keyof typeof PUSH_EVENT_GROUPS;

export const PUSH_EVENT_GROUP_KEYS = Object.keys(PUSH_EVENT_GROUPS) as PushEventGroup[];

export function isPushEventGroup(value: unknown): value is PushEventGroup {
  return typeof value === 'string' && Object.hasOwn(PUSH_EVENT_GROUPS, value);
}

export function eventsForGroup(group: PushEventGroup): readonly string[] {
  return PUSH_EVENT_GROUPS[group];
}

/** Every event type a preference can cover; used to expand "disable this group" into rows. */
export function allPushEventTypes(): string[] {
  return [...new Set(PUSH_EVENT_GROUP_KEYS.flatMap((key) => [...eventsForGroup(key)]))];
}

/** Reverse lookup, so an opt-out can be reported under the group the user actually touched. */
export function groupOfEvent(eventType: string): PushEventGroup | null {
  for (const key of PUSH_EVENT_GROUP_KEYS) {
    if (eventsForGroup(key).includes(eventType)) return key;
  }
  return null;
}

/** A push endpoint is an absolute https URL handed to us by the browser. */
export function endpointMatches(endpoint: string): boolean {
  return /^https:\/\/\S{4,}$/.test(endpoint.trim());
}

export type PushState = 'NONE' | 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

/**
 * One word for the whole push story of an inbox row. Precedence is deliberate: pending beats sent
 * (something is still owed), sent beats failed (the user got it once), and an all-skipped set is
 * reported as SKIPPED rather than FAILED, because nothing was wrong with the send — the channel is off.
 */
export function pushStateSummary(counts: {
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
  total?: number;
}): { state: PushState } {
  const total = counts.total ?? counts.sent + counts.pending + counts.failed + counts.skipped;
  if (!total) return { state: 'NONE' };
  if (counts.pending > 0) return { state: 'PENDING' };
  if (counts.sent > 0) return { state: 'SENT' };
  if (counts.failed > 0) return { state: 'FAILED' };
  return { state: 'SKIPPED' };
}
