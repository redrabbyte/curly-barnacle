/**
 * What a push notification is *about*, rather than what it says.
 *
 * The server used to compose the sentence, which meant it decided the reader's
 * language — and it has no idea what that is. It sends a kind plus the actor's
 * name now, and the service worker writes the words in whatever language the
 * reader chose. The group is named by id: its name is sealed, so the server
 * cannot say it, and the device that shows the notification holds it opened
 * in the mirror. Everything about the entry itself is still absent by design
 * (§3.3).
 */
export const NOTIFICATION_KINDS = [
  'expense.saved',
  'expense.deleted',
  'payment.recorded',
  'comment.added',
  'member.joined',
  'member.left',
  'member.removed',
  'join.requested',
  'join.approved',
  // Somebody already in the group saying one of its names is them (design §5).
  // Distinct from `join.requested`: they are a member either way, and what an
  // admin is being asked to weigh is a stretch of the ledger changing hands.
  'claim.requested',
  'claim.approved',
  'you.removed',
  'you.promoted',
  'you.promoted.lastAdminLeft',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Which sealed entry a notification is about, for the kinds that have one. */
export interface PushEntry {
  type: 'expense' | 'payment';
  id: string;
  groupId: string;
}

/**
 * The wire form of a push payload.
 *
 * Safe to carry the entry's identity: a Web Push payload is encrypted to the
 * subscription's own keys, so the push service moving it sees ciphertext, and
 * the only parties that read it are this server — which assigned the id — and
 * the device. Nothing about the entry's *content* is in here, which is the
 * line that matters (design §3.3).
 */
export interface PushPayload {
  kind: NotificationKind;
  /**
   * Which group. The title is its name, which only the device can supply: it
   * is sealed on the server and opened in the mirror, so the worker looks it
   * up by this id and falls back to something generic when it has never held
   * the group.
   */
  groupId: string;
  /** Who did it, for the kinds that name somebody. */
  actor?: string;
  /** In-app path the notification opens. */
  url: string;
  /**
   * The entry this is about, when it is about one. The server cannot tell who
   * an entry names — that is inside the blob — so it sends the id and lets the
   * device, which can open it, decide whether to make a noise (design §3.3).
   * Absent on the group- and account-level kinds, which concern everybody who
   * receives them.
   */
  entry?: PushEntry;
}

export const isNotificationKind = (v: unknown): v is NotificationKind =>
  typeof v === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(v);
