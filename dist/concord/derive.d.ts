/** 32 raw bytes from a 64-char hex string, rejecting anything else. */
export declare function bytes32(hex: string, what?: string): Uint8Array;
/**
 * A plane's stream keypair (A.2). The x-only pubkey is the on-wire Stream
 * address (what `authors` filters match), the secret key signs the plane's
 * wraps, and the NIP-44 self-ECDH conversation key encrypts them. Only holders
 * of the deriving secret can produce any of the three.
 */
export interface GroupKey {
    /** Stream address, x-only hex. */
    readonly pk: string;
    /** Signs this plane's wraps. SECRET. */
    readonly sk: Uint8Array;
    /** NIP-44 conversation key (self-ECDH) that encrypts this plane's wraps. SECRET. */
    readonly convKey: Uint8Array;
}
/**
 * A channel's Chat Plane key. `secret` is the community root for a public
 * channel (at the root epoch) or the channel's own key for a private one (at
 * the channel's epoch).
 */
export declare function channelGroupKey(secret: Uint8Array, channelId: Uint8Array, epoch: number | bigint): GroupKey;
/**
 * The Control Plane's root-keyed key. Post-split this is only the plane's READ
 * key (its conv key decrypts every member's view); on a legacy pre-split epoch
 * its pk was also the address.
 */
export declare function controlGroupKey(communityRoot: Uint8Array, communityId: Uint8Array, epoch: number | bigint): GroupKey;
/** The Control Plane's staff-only signer (its pk is the plane's address post-split). */
export declare function controlSignerGroupKey(controlRoot: Uint8Array, communityId: Uint8Array, epoch: number | bigint): GroupKey;
/** The Guestbook Plane key: membership joins and leaves. */
export declare function guestbookGroupKey(communityRoot: Uint8Array, communityId: Uint8Array, epoch: number | bigint): GroupKey;
/** A private channel's rekey address for `newEpoch`, keyed by the community root. */
export declare function channelRekeyGroupKey(root: Uint8Array, channelId: Uint8Array, newEpoch: number | bigint): GroupKey;
/** The base-rotation rekey address for `newEpoch`, keyed by the PRIOR root. */
export declare function baseRekeyGroupKey(priorRoot: Uint8Array, communityId: Uint8Array, newEpoch: number | bigint): GroupKey;
/** The dissolution tombstone key: from the community id alone, no key, no epoch. */
export declare function dissolvedGroupKey(communityId: Uint8Array): GroupKey;
/** `community_id = sha256("concord/community" || owner_xonly || owner_salt)`. */
export declare function communityIdOf(ownerXonly: Uint8Array, ownerSalt: Uint8Array): Uint8Array;
/**
 * Whether a claimed `(owner, salt)` reproduces `communityId`. Every path that
 * trusts a claimed owner must pass this first.
 */
export declare function verifyCommunityId(communityId: string, owner: string, ownerSalt: string): boolean;
/** `sha256("concord/epoch-key-commitment" || prev_epoch_be || prev_key)`: rekey continuity. */
export declare function epochKeyCommitment(prevEpoch: number | bigint, prevKey: Uint8Array): Uint8Array;
