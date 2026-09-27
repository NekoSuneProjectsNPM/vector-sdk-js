/**
 * The Concord v2 Guestbook Plane (CORD-02 §5): membership motion only.
 *
 * A port of the join/leave parts of `vector-core/src/community/v2/guestbook.rs`.
 * A member announces itself with a self-signed kind-3306 rumor whose content is
 * exactly `"join"` or `"leave"`, sealed ENCRYPTED and wrapped at the
 * community's guestbook key. Only a real first join should speak: every
 * re-publish renders as "<user> has joined" for the whole community.
 */
import type { Event } from 'nostr-tools';

import type { GroupKey } from './derive.js';
import { StreamError, buildRumorMs, buildSeal, openWrap, wrapSeal } from './stream.js';
import type { OpenedStream, Rumor } from './stream.js';

export const KIND_JOIN_LEAVE = 3306;
export const KIND_KICK = 3309;

export type GuestbookEntry =
  | { type: 'join'; member: string; atMs: number; invitedBy?: { creator: string; label: string } }
  | { type: 'leave'; member: string; atMs: number }
  | { type: 'kick'; author: string; target: string; atMs: number };

/**
 * A self-signed join, echoing the invite attribution from the bundle that
 * admitted the author (`["invite", creator, label]`, CORD-05 §1).
 */
export function buildJoinRumor(author: string, invite?: { creator: string; label: string }, atMs: number = Date.now()): Rumor {
  const tags = invite ? [['invite', invite.creator, invite.label]] : [];
  return buildRumorMs(KIND_JOIN_LEAVE, author, 'join', tags, atMs);
}

/** A self-signed leave. */
export function buildLeaveRumor(author: string, atMs: number = Date.now()): Rumor {
  return buildRumorMs(KIND_JOIN_LEAVE, author, 'leave', [], atMs);
}

/** Seal (encrypted, by spec) and wrap a guestbook rumor. */
export function sealGuestbookRumor(rumor: Rumor, group: GroupKey, authorSk: Uint8Array): Event {
  const seal = buildSeal(rumor, 'encrypted', group, authorSk);
  return wrapSeal(seal, group, { wrapAt: rumor.created_at });
}

/** Read an opened guestbook event. A plaintext seal is rejected outright. */
export function parseGuestbookEvent(opened: OpenedStream): GuestbookEntry {
  if (opened.sealForm !== 'encrypted') {
    throw new StreamError('not-encrypted-sealed', 'guestbook entries must ride an encrypted seal');
  }
  const { rumor } = opened;
  if (rumor.kind === KIND_JOIN_LEAVE) {
    if (rumor.content === 'join') {
      const invite = rumor.tags.find((t) => t[0] === 'invite' && t.length >= 3);
      return {
        type: 'join',
        member: opened.author,
        atMs: opened.atMs,
        invitedBy: invite ? { creator: invite[1], label: invite[2] } : undefined,
      };
    }
    if (rumor.content === 'leave') {
      return { type: 'leave', member: opened.author, atMs: opened.atMs };
    }
    throw new StreamError('bad-verb', 'a 3306 must be exactly "join" or "leave"');
  }
  if (rumor.kind === KIND_KICK) {
    const targets = rumor.tags.filter((t) => t[0] === 'p' && t.length >= 2);
    if (targets.length !== 1) {
      throw new StreamError(targets.length ? 'duplicate-tag' : 'missing-tag', 'p');
    }
    return { type: 'kick', author: opened.author, target: targets[0][1], atMs: opened.atMs };
  }
  throw new StreamError('unknown-kind', String(rumor.kind));
}

/** Open a wrap at the guestbook key and read it. */
export function openGuestbookEvent(wrap: Event, group: GroupKey): GuestbookEntry {
  return parseGuestbookEvent(openWrap(wrap, group));
}
