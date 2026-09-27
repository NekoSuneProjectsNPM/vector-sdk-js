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
import type { OpenedStream, Rumor } from './stream.js';
/** Inner rumor kinds (CORD-02 Appendix B). */
export declare const ChatKind: {
    readonly MESSAGE: 9;
    readonly COMMENT: 1111;
    readonly REACTION: 7;
    readonly DELETE: 5;
    readonly EDIT: 3302;
    readonly WEBXDC: 3310;
    readonly TYPING: 23311;
};
export type ChatEvent = {
    type: 'message';
    opened: OpenedStream;
    replyTo?: {
        id: string;
        author?: string;
    };
    emoji: [string, string][];
} | {
    type: 'reaction';
    opened: OpenedStream;
    target: string;
    targetAuthor: string;
    emoji: string;
    emojiUrl?: string;
} | {
    type: 'delete';
    opened: OpenedStream;
    target: string;
    targetKind?: number;
} | {
    type: 'edit';
    opened: OpenedStream;
    target: string;
    newContent: string;
    emoji: [string, string][];
} | {
    type: 'webxdc';
    opened: OpenedStream;
} | {
    type: 'typing';
    opened: OpenedStream;
};
export { channelGroupKey as chatGroupKey };
/**
 * A kind-9 message. `replyTo` becomes an inline quote
 * (`["q", parent_id, "", parent_author]`), which is how Vector renders a reply.
 */
export declare function buildMessageRumor(author: string, channelId: string, epoch: number, content: string, options?: {
    replyTo?: {
        id: string;
        author: string;
    };
    emoji?: [string, string][];
    extraTags?: string[][];
    atMs?: number;
}): Rumor;
/** A NIP-25 reaction to a message (`k` is the target's kind, 9 or 1111). */
export declare function buildReactionRumor(author: string, channelId: string, epoch: number, target: {
    id: string;
    author: string;
    kind?: number;
}, emoji: string, options?: {
    emojiUrl?: string;
    atMs?: number;
}): Rumor;
/** Edit one of the author's own messages (content = the replacement text). */
export declare function buildEditRumor(author: string, channelId: string, epoch: number, targetId: string, newContent: string, options?: {
    emoji?: [string, string][];
    atMs?: number;
}): Rumor;
/** Delete one of the author's own messages. */
export declare function buildDeleteRumor(author: string, channelId: string, epoch: number, targetId: string, targetKind?: number, atMs?: number): Rumor;
/** A typing indicator (sent in an ephemeral 21059 wrap, never stored). */
export declare function buildTypingRumor(author: string, channelId: string, epoch: number, atMs?: number): Rumor;
/**
 * Seal and wrap a chat rumor. A NIP-40 `expiration` on the rumor is mirrored
 * onto the wrap so relays drop the stored event on schedule.
 */
export declare function sealChatRumor(rumor: Rumor, group: GroupKey, authorSk: Uint8Array, options?: {
    ephemeral?: boolean;
    wrapAt?: number;
}): Event;
/** Classify an opened chat rumor by kind. */
export declare function parseChatRumor(opened: OpenedStream): ChatEvent;
/** Open a wrap as a chat event of exactly this channel and epoch. */
export declare function openChatEvent(wrap: Event, group: GroupKey, channelId: string, epoch: number): ChatEvent;
