import { StreamError, buildRumorMs, buildSeal, openWrap, wrapSeal } from './stream.js';
export const KIND_JOIN_LEAVE = 3306;
export const KIND_KICK = 3309;
/**
 * A self-signed join, echoing the invite attribution from the bundle that
 * admitted the author (`["invite", creator, label]`, CORD-05 §1).
 */
export function buildJoinRumor(author, invite, atMs = Date.now()) {
    const tags = invite ? [['invite', invite.creator, invite.label]] : [];
    return buildRumorMs(KIND_JOIN_LEAVE, author, 'join', tags, atMs);
}
/** A self-signed leave. */
export function buildLeaveRumor(author, atMs = Date.now()) {
    return buildRumorMs(KIND_JOIN_LEAVE, author, 'leave', [], atMs);
}
/** Seal (encrypted, by spec) and wrap a guestbook rumor. */
export function sealGuestbookRumor(rumor, group, authorSk) {
    const seal = buildSeal(rumor, 'encrypted', group, authorSk);
    return wrapSeal(seal, group, { wrapAt: rumor.created_at });
}
/** Read an opened guestbook event. A plaintext seal is rejected outright. */
export function parseGuestbookEvent(opened) {
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
export function openGuestbookEvent(wrap, group) {
    return parseGuestbookEvent(openWrap(wrap, group));
}
