import { channelGroupKey } from './derive.js';
import { KIND_WRAP, KIND_WRAP_EPHEMERAL, StreamError, buildRumorMs, buildSeal, channelBindingTags, checkChannelBinding, openWrap, uniqueTag, wrapSeal, } from './stream.js';
/** Inner rumor kinds (CORD-02 Appendix B). */
export const ChatKind = {
    MESSAGE: 9,
    COMMENT: 1111,
    REACTION: 7,
    DELETE: 5,
    EDIT: 3302,
    WEBXDC: 3310,
    TYPING: 23311,
};
const CHAT_KINDS = new Set(Object.values(ChatKind));
export { channelGroupKey as chatGroupKey };
// ── builders ─────────────────────────────────────────────────────────────────
function emojiTags(emoji = []) {
    return emoji.map(([shortcode, url]) => ['emoji', shortcode, url]);
}
/**
 * A kind-9 message. `replyTo` becomes an inline quote
 * (`["q", parent_id, "", parent_author]`), which is how Vector renders a reply.
 */
export function buildMessageRumor(author, channelId, epoch, content, options = {}) {
    const tags = channelBindingTags(channelId, epoch);
    if (options.replyTo) {
        tags.push(['q', options.replyTo.id, '', options.replyTo.author]);
    }
    tags.push(...emojiTags(options.emoji), ...(options.extraTags ?? []));
    return buildRumorMs(ChatKind.MESSAGE, author, content, tags, options.atMs ?? Date.now());
}
/** A NIP-25 reaction to a message (`k` is the target's kind, 9 or 1111). */
export function buildReactionRumor(author, channelId, epoch, target, emoji, options = {}) {
    const tags = channelBindingTags(channelId, epoch);
    tags.push(['e', target.id], ['p', target.author], ['k', String(target.kind ?? ChatKind.MESSAGE)]);
    if (options.emojiUrl) {
        tags.push(['emoji', emoji.replace(/^:|:$/g, ''), options.emojiUrl]);
    }
    return buildRumorMs(ChatKind.REACTION, author, emoji, tags, options.atMs ?? Date.now());
}
/** Edit one of the author's own messages (content = the replacement text). */
export function buildEditRumor(author, channelId, epoch, targetId, newContent, options = {}) {
    const tags = channelBindingTags(channelId, epoch);
    tags.push(['e', targetId], ...emojiTags(options.emoji));
    return buildRumorMs(ChatKind.EDIT, author, newContent, tags, options.atMs ?? Date.now());
}
/** Delete one of the author's own messages. */
export function buildDeleteRumor(author, channelId, epoch, targetId, targetKind = ChatKind.MESSAGE, atMs = Date.now()) {
    const tags = channelBindingTags(channelId, epoch);
    tags.push(['e', targetId], ['k', String(targetKind)]);
    return buildRumorMs(ChatKind.DELETE, author, '', tags, atMs);
}
/** A typing indicator (sent in an ephemeral 21059 wrap, never stored). */
export function buildTypingRumor(author, channelId, epoch, atMs = Date.now()) {
    return buildRumorMs(ChatKind.TYPING, author, '', channelBindingTags(channelId, epoch), atMs);
}
/**
 * Seal and wrap a chat rumor. A NIP-40 `expiration` on the rumor is mirrored
 * onto the wrap so relays drop the stored event on schedule.
 */
export function sealChatRumor(rumor, group, authorSk, options = {}) {
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
function hex32(value, field) {
    if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
        throw new StreamError('bad-tag', field);
    }
    return value.toLowerCase();
}
function optionalAuthor(tag, field) {
    const author = tag[3];
    return author ? hex32(author, field) : undefined;
}
function requiredTag(rumor, name) {
    const tag = uniqueTag(rumor, name);
    if (!tag)
        throw new StreamError('missing-tag', name);
    return tag[1];
}
function collectEmoji(rumor) {
    return rumor.tags.filter((t) => t[0] === 'emoji' && t.length >= 3).map((t) => [t[1], t[2]]);
}
/** Classify an opened chat rumor by kind. */
export function parseChatRumor(opened) {
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
export function openChatEvent(wrap, group, channelId, epoch) {
    const opened = openWrap(wrap, group);
    if (opened.sealForm !== 'encrypted') {
        throw new StreamError('not-encrypted-sealed', 'chat rumors must ride an encrypted seal');
    }
    checkChannelBinding(opened.rumor, channelId, epoch);
    return parseChatRumor(opened);
}
