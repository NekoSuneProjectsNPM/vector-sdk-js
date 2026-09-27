/**
 * The Concord v2 Chat Plane (CORD-03): messages, replies, reactions, edits,
 * deletes and typing inside a community channel.
 *
 * A port of `vector-core/src/community/v2/chat.rs`. Every chat rumor commits
 * `["channel", id]` + `["epoch", n]` and an `ms` tag, rides an ENCRYPTED seal,
 * and is wrapped at the channel's group key.
 */
import type { Event } from 'nostr-tools';

import { channelGroupKey } from './derive.js';
import type { GroupKey } from './derive.js';
import {
  KIND_WRAP,
  KIND_WRAP_EPHEMERAL,
  StreamError,
  buildRumorMs,
  buildSeal,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  uniqueTag,
  wrapSeal,
} from './stream.js';
import type { OpenedStream, Rumor } from './stream.js';

/** Inner rumor kinds (CORD-02 Appendix B). */
export const ChatKind = {
  MESSAGE: 9,
  COMMENT: 1111,
  REACTION: 7,
  DELETE: 5,
  EDIT: 3302,
  WEBXDC: 3310,
  TYPING: 23311,
} as const;

const CHAT_KINDS = new Set<number>(Object.values(ChatKind));

export type ChatEvent =
  | { type: 'message'; opened: OpenedStream; replyTo?: { id: string; author?: string }; emoji: [string, string][] }
  | { type: 'reaction'; opened: OpenedStream; target: string; targetAuthor: string; emoji: string; emojiUrl?: string }
  | { type: 'delete'; opened: OpenedStream; target: string; targetKind?: number }
  | { type: 'edit'; opened: OpenedStream; target: string; newContent: string; emoji: [string, string][] }
  | { type: 'webxdc'; opened: OpenedStream }
  | { type: 'typing'; opened: OpenedStream };

export { channelGroupKey as chatGroupKey };

// ── builders ─────────────────────────────────────────────────────────────────

function emojiTags(emoji: [string, string][] = []): string[][] {
  return emoji.map(([shortcode, url]) => ['emoji', shortcode, url]);
}

/**
 * A kind-9 message. `replyTo` becomes an inline quote
 * (`["q", parent_id, "", parent_author]`), which is how Vector renders a reply.
 */
export function buildMessageRumor(
  author: string,
  channelId: string,
  epoch: number,
  content: string,
  options: { replyTo?: { id: string; author: string }; emoji?: [string, string][]; extraTags?: string[][]; atMs?: number } = {},
): Rumor {
  const tags = channelBindingTags(channelId, epoch);
  if (options.replyTo) {
    tags.push(['q', options.replyTo.id, '', options.replyTo.author]);
  }
  tags.push(...emojiTags(options.emoji), ...(options.extraTags ?? []));
  return buildRumorMs(ChatKind.MESSAGE, author, content, tags, options.atMs ?? Date.now());
}

/** A NIP-25 reaction to a message (`k` is the target's kind, 9 or 1111). */
export function buildReactionRumor(
  author: string,
  channelId: string,
  epoch: number,
  target: { id: string; author: string; kind?: number },
  emoji: string,
  options: { emojiUrl?: string; atMs?: number } = {},
): Rumor {
  const tags = channelBindingTags(channelId, epoch);
  tags.push(['e', target.id], ['p', target.author], ['k', String(target.kind ?? ChatKind.MESSAGE)]);
  if (options.emojiUrl) {
    tags.push(['emoji', emoji.replace(/^:|:$/g, ''), options.emojiUrl]);
  }
  return buildRumorMs(ChatKind.REACTION, author, emoji, tags, options.atMs ?? Date.now());
}

/** Edit one of the author's own messages (content = the replacement text). */
export function buildEditRumor(
  author: string,
  channelId: string,
  epoch: number,
  targetId: string,
  newContent: string,
  options: { emoji?: [string, string][]; atMs?: number } = {},
): Rumor {
  const tags = channelBindingTags(channelId, epoch);
  tags.push(['e', targetId], ...emojiTags(options.emoji));
  return buildRumorMs(ChatKind.EDIT, author, newContent, tags, options.atMs ?? Date.now());
}

/** Delete one of the author's own messages. */
export function buildDeleteRumor(
  author: string,
  channelId: string,
  epoch: number,
  targetId: string,
  targetKind: number = ChatKind.MESSAGE,
  atMs: number = Date.now(),
): Rumor {
  const tags = channelBindingTags(channelId, epoch);
  tags.push(['e', targetId], ['k', String(targetKind)]);
  return buildRumorMs(ChatKind.DELETE, author, '', tags, atMs);
}

/** A typing indicator (sent in an ephemeral 21059 wrap, never stored). */
export function buildTypingRumor(author: string, channelId: string, epoch: number, atMs: number = Date.now()): Rumor {
  return buildRumorMs(ChatKind.TYPING, author, '', channelBindingTags(channelId, epoch), atMs);
}

/**
 * Seal and wrap a chat rumor. A NIP-40 `expiration` on the rumor is mirrored
 * onto the wrap so relays drop the stored event on schedule.
 */
export function sealChatRumor(rumor: Rumor, group: GroupKey, authorSk: Uint8Array, options: { ephemeral?: boolean; wrapAt?: number } = {}): Event {
  if (!CHAT_KINDS.has(rumor.kind)) {
    throw new StreamError('unknown-kind', `rumor kind ${rumor.kind} is not a chat-plane kind`);
  }
  const seal = buildSeal(rumor, 'encrypted', group, authorSk);
  return wrapSeal(seal, group, {
    kind: options.ephemeral ? KIND_WRAP_EPHEMERAL : KIND_WRAP,
    wrapAt: options.wrapAt ?? Math.floor(rumor.created_at),
    extraTags: rumor.tags.filter((t) => t[0] === 'expiration'),
  });
}

// ── open side ────────────────────────────────────────────────────────────────

function hex32(value: string | undefined, field: string): string {
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new StreamError('bad-tag', field);
  }
  return value.toLowerCase();
}

function optionalAuthor(tag: string[], field: string): string | undefined {
  const author = tag[3];
  return author ? hex32(author, field) : undefined;
}

function requiredTag(rumor: Rumor, name: string): string {
  const tag = uniqueTag(rumor, name);
  if (!tag) throw new StreamError('missing-tag', name);
  return tag[1];
}

function collectEmoji(rumor: Rumor): [string, string][] {
  return rumor.tags.filter((t) => t[0] === 'emoji' && t.length >= 3).map((t) => [t[1], t[2]] as [string, string]);
}

/** Classify an opened chat rumor by kind. */
export function parseChatRumor(opened: OpenedStream): ChatEvent {
  const { rumor } = opened;
  switch (rumor.kind) {
    case ChatKind.MESSAGE: {
      const quote = uniqueTag(rumor, 'q');
      const replyTo = quote ? { id: hex32(quote[1], 'q'), author: optionalAuthor(quote, 'q') } : undefined;
      return { type: 'message', opened, replyTo, emoji: collectEmoji(rumor) };
    }
    case ChatKind.COMMENT: {
      // A threaded reply: lowercase `e` is the immediate parent. A parentless
      // comment still renders as plain text.
      const parent = uniqueTag(rumor, 'e');
      const replyTo = parent ? { id: hex32(parent[1], 'e'), author: optionalAuthor(parent, 'e') } : undefined;
      return { type: 'message', opened, replyTo, emoji: collectEmoji(rumor) };
    }
    case ChatKind.REACTION:
      return {
        type: 'reaction',
        opened,
        target: hex32(requiredTag(rumor, 'e'), 'e'),
        targetAuthor: hex32(requiredTag(rumor, 'p'), 'p'),
        emoji: rumor.content,
        emojiUrl: collectEmoji(rumor)[0]?.[1],
      };
    case ChatKind.DELETE: {
      const kindTag = uniqueTag(rumor, 'k');
      const targetKind = kindTag ? Number(kindTag[1]) : undefined;
      if (targetKind !== undefined && !Number.isInteger(targetKind)) {
        throw new StreamError('bad-tag', 'k');
      }
      return { type: 'delete', opened, target: hex32(requiredTag(rumor, 'e'), 'e'), targetKind };
    }
    case ChatKind.EDIT:
      return {
        type: 'edit',
        opened,
        target: hex32(requiredTag(rumor, 'e'), 'e'),
        newContent: rumor.content,
        emoji: collectEmoji(rumor),
      };
    case ChatKind.WEBXDC:
      return { type: 'webxdc', opened };
    case ChatKind.TYPING:
      return { type: 'typing', opened };
    default:
      throw new StreamError('unknown-kind', String(rumor.kind));
  }
}

/** Open a wrap as a chat event of exactly this channel and epoch. */
export function openChatEvent(wrap: Event, group: GroupKey, channelId: string, epoch: number): ChatEvent {
  const opened = openWrap(wrap, group);
  if (opened.sealForm !== 'encrypted') {
    throw new StreamError('not-encrypted-sealed', 'chat rumors must ride an encrypted seal');
  }
  checkChannelBinding(opened.rumor, channelId, epoch);
  return parseChatRumor(opened);
}
