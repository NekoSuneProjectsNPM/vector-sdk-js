/**
 * Community invites (kind 3304).
 *
 * An invite is a JSON bundle gift-wrapped to the invitee over NIP-17 — the same
 * private-DM path as any other message. The bundle is plain JSON inside the
 * wrap, so reading one, checking it and passing it on are all things this
 * package can do.
 *
 * What it cannot do is *mint* one. A bundle hands out live key material for the
 * community (`serverRootKey`, per-channel epoch keys, the owner attestation),
 * which only a member holding that community's state can produce — and that
 * state lives in `vector-core`. So a bot forwards invites it was given; it does
 * not create them.
 *
 * A bundle is live key material and arrives over an unauthenticated gift wrap
 * from an arbitrary sender, so it is untrusted input: every field is bounded on
 * read, matching `vector_core::community::invite`.
 */
import type { Event } from 'nostr-tools';
import { COMMUNITY_INVITE_BUNDLE } from './kinds.js';
/**
 * How long a direct invite stays valid, in seconds.
 *
 * A bundle carries keys for a community that keeps evolving — rotations,
 * renames, bans — so an invite that never expired would be stale key material.
 * Senders stamp NIP-40 on the rumor and the wrap, but relay support for NIP-40
 * is optional, so receivers enforce the expiry themselves.
 */
export declare const DIRECT_INVITE_EXPIRY_SECS: number;
/**
 * Caps on a received bundle. A hostile sender could otherwise declare an
 * unbounded channel or relay list and force mass allocation on every recipient.
 */
export declare const MAX_INVITE_RELAYS = 5;
export declare const MAX_INVITE_CHANNELS = 64;
export declare const MAX_INVITE_BYTES: number;
export declare class InviteError extends Error {
}
/** One channel described by an invite bundle. */
export interface InviteChannel {
    id: string;
    name?: string;
    epoch?: number;
    isPrivate?: boolean;
}
/** A community invite bundle, as carried by a kind-3304 rumor. */
export interface CommunityInvite {
    communityId: string;
    name: string;
    /** The community's server-root key. Secret — this is what grants access. */
    serverRootKey: string;
    /** The server root's current epoch, so a joiner adopts the right read clock. */
    serverRootEpoch: number;
    relays: string[];
    channels: InviteChannel[];
    /** Signed event JSON proving who the owner is, when the sender included it. */
    ownerAttestation?: string;
    /** The raw bundle, exactly as it arrived. Forwarding re-sends this verbatim. */
    raw: Record<string, unknown>;
}
/** An invite as received, with the envelope details a caller needs to act on it. */
export interface ReceivedInvite {
    invite: CommunityInvite;
    /** Who sent it, hex pubkey. */
    senderPubkey: string;
    /** The rumor id. */
    messageId?: string;
    /** NIP-40 expiry in Unix seconds, when the sender declared one. */
    expiresAt?: number;
    /** Whether that expiry has already passed. */
    expired: boolean;
}
/** Read a NIP-40 `expiration` tag (Unix seconds) off a rumor's tags. */
export declare function expirationSeconds(tags: string[][]): number | undefined;
/**
 * Parse a rumor's content as a community invite bundle.
 *
 * Returns `null` rather than throwing when the rumor is not an invite or the
 * bundle is malformed, so an inbound dispatcher can simply fall through to
 * treating it as an ordinary message.
 */
export declare function parseCommunityInvite(rumor: {
    kind: number;
    content: string;
}): CommunityInvite | null;
/**
 * Read an unwrapped gift-wrap rumor as a received invite.
 *
 * Returns `null` when the rumor is not an invite. An expired invite is still
 * returned, flagged — the caller decides whether a stale invite is worth
 * surfacing, and silently dropping one would look like it never arrived.
 */
export declare function readInviteRumor(rumor: {
    kind: number;
    content: string;
    tags: string[][];
    pubkey: string;
    id?: string;
}, now?: number): ReceivedInvite | null;
/**
 * Build the rumor that carries `invite` to someone else.
 *
 * The bundle is re-sent verbatim, because it is the community's key material
 * and not ours to rewrite. The NIP-40 expiry is preserved when the original
 * had one, so forwarding cannot extend an invite's life beyond what the issuer
 * granted; an invite with no declared expiry gets the standard 24 hours.
 */
export declare function buildInviteRumor(invite: CommunityInvite, options?: {
    expiresAt?: number;
}): {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
};
/** True when `event` is a gift wrap that might carry an invite. */
export declare function isInviteKind(kind: number): boolean;
/** Re-export so callers can filter on the kind without a second import. */
export { COMMUNITY_INVITE_BUNDLE };
export type { Event };
