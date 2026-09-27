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
import type { OpenedStream, Rumor } from './stream.js';
export declare const KIND_JOIN_LEAVE = 3306;
export declare const KIND_KICK = 3309;
export type GuestbookEntry = {
    type: 'join';
    member: string;
    atMs: number;
    invitedBy?: {
        creator: string;
        label: string;
    };
} | {
    type: 'leave';
    member: string;
    atMs: number;
} | {
    type: 'kick';
    author: string;
    target: string;
    atMs: number;
};
/**
 * A self-signed join, echoing the invite attribution from the bundle that
 * admitted the author (`["invite", creator, label]`, CORD-05 §1).
 */
export declare function buildJoinRumor(author: string, invite?: {
    creator: string;
    label: string;
}, atMs?: number): Rumor;
/** A self-signed leave. */
export declare function buildLeaveRumor(author: string, atMs?: number): Rumor;
/** Seal (encrypted, by spec) and wrap a guestbook rumor. */
export declare function sealGuestbookRumor(rumor: Rumor, group: GroupKey, authorSk: Uint8Array): Event;
/** Read an opened guestbook event. A plaintext seal is rejected outright. */
export declare function parseGuestbookEvent(opened: OpenedStream): GuestbookEntry;
/** Open a wrap at the guestbook key and read it. */
export declare function openGuestbookEvent(wrap: Event, group: GroupKey): GuestbookEntry;
