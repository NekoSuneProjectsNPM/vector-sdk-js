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
import { COMMUNITY_DIRECT_INVITE, COMMUNITY_INVITE_BUNDLE } from './kinds.js';
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
/** Concord v2 caps, from `vector_core::community::v2::invite`. */
export declare const MAX_BUNDLE_CHANNELS = 256;
export declare const MAX_BOOTSTRAP_RELAYS = 3;
export declare const MAX_BUNDLE_EPOCH: number;
export declare class InviteError extends Error {
}
/**
 * One channel described by an invite bundle.
 *
 * In a v2 bundle this is a *grant*: `key` is the channel's actual access key,
 * so a channel listed with one is a channel the invite lets you read.
 */
export interface InviteChannel {
    id: string;
    name?: string;
    epoch?: number;
    isPrivate?: boolean;
    /** Channel key (v2 grants only). Secret. */
    key?: string;
}
/**
 * Which protocol generation an invite came from.
 *
 * `v2` (kind 3313) is what a current Vector app sends. `v1` (kind 3304) is the
 * older bundle. Both are read here; only the shape of the JSON differs.
 */
export type InviteProtocol = 'v1' | 'v2';
/** A community invite bundle. */
export interface CommunityInvite {
    /** Which generation of the protocol issued this invite. */
    protocol: InviteProtocol;
    communityId: string;
    name: string;
    /**
     * The base access key. Secret — this is what the bundle actually grants.
     *
     * `server_root_key` in a v1 bundle, `community_root` in a v2 one. The two
     * generations name it differently on the wire; this is the common handle.
     */
    accessKey: string;
    /** The epoch that `accessKey` belongs to, so a joiner reads at the right clock. */
    epoch: number;
    /** Owner x-only pubkey, hex (v2). The community id self-certifies from it. */
    owner?: string;
    /** Owner salt, hex (v2). */
    ownerSalt?: string;
    /** The control plane's signer pubkey at `epoch` (v2, optional). */
    controlPk?: string;
    /** Who created the invite, echoed in the joiner's guestbook entry (v2). */
    creatorNpub?: string;
    /** Free-text label the inviter attached (v2). */
    label?: string;
    relays: string[];
    channels: InviteChannel[];
    /** Signed event JSON proving who the owner is, when the sender included it. */
    ownerAttestation?: string;
    /** The bundle's own deadline in Unix MILLISECONDS, when it declares one (v2). */
    expiresAtMs?: number;
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
/** True when `kind` is either generation's invite. */
export declare function isInviteKind(kind: number): boolean;
/** Re-export so callers can filter on the kinds without a second import. */
export { COMMUNITY_INVITE_BUNDLE, COMMUNITY_DIRECT_INVITE };
export type { Event };
