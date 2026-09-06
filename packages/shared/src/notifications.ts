/**
 * What a push notification is *about*, rather than what it says.
 *
 * The server used to compose the sentence, which meant it decided the reader's
 * language — and it has no idea what that is. It sends a kind plus the names
 * involved now, and the service worker writes the words in whatever language
 * the reader chose. Nothing new is revealed: the group and actor names were
 * already in the payload, and everything about the entry itself is still
 * absent by design (§3.3).
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
  /** Group name — the notification title. */
  group: string;
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
