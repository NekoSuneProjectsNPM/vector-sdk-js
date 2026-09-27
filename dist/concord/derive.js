/**
 * Concord v2 key derivations (CORD-02 Appendix A). **Frozen wire format.**
 *
 * A port of `vector-core/src/community/v2/derive.rs`. Every address a v2
 * community uses on the wire comes from a community secret through one of
 * these shapes; changing any labeled byte re-addresses every prior event. The
 * golden vectors in `tests/concord.test.mjs` are copied from the Rust test
 * module (minted there by an independent implementation) and are the spec.
 *
 * Construction (A.1): `HKDF-SHA256(ikm = secret, salt = ∅, info, L = 32)` with
 * `info = utf8(label) || 0x00 || id[32] || epoch_be[8]?`. The id is always
 * present (all zeroes when a label has none); the epoch is the only omittable
 * field.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { getPublicKey, nip44 } from 'nostr-tools';
// A.6 purpose labels. Part of the wire format: append, never edit or reuse.
const LABEL_CHANNEL = 'concord/channel';
const LABEL_CONTROL = 'concord/control';
const LABEL_CONTROL_SIGNER = 'concord/control-signer';
const LABEL_REKEY_PSEUDONYM = 'concord/rekey-pseudonym';
const LABEL_BASE_REKEY_PSEUDONYM = 'concord/base-rekey-pseudonym';
const LABEL_GUESTBOOK = 'concord/guestbook';
const LABEL_DISSOLVED = 'concord/dissolved';
// A.4 / A.5 are plain SHA-256 commitments, not the HKDF shape.
const LABEL_COMMUNITY = 'concord/community';
const LABEL_EPOCH_COMMITMENT = 'concord/epoch-key-commitment';
const ZERO32 = new Uint8Array(32);
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const encoder = new TextEncoder();
/** 32 raw bytes from a 64-char hex string, rejecting anything else. */
export function bytes32(hex, what = 'value') {
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
        throw new Error(`${what} must be 32 bytes of hex`);
    }
    return hexToBytes(hex.toLowerCase());
}
function epochBytes(epoch) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(epoch));
    return out;
}
function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
/** The frozen A.1 `info` string. `epoch` is undefined for the no-epoch labels. */
function buildInfo(label, id32, epoch) {
    const parts = [encoder.encode(label), new Uint8Array([0]), id32];
    if (epoch !== undefined) {
        parts.push(epochBytes(epoch));
    }
    return concat(...parts);
}
/** HKDF-SHA256 to 32 bytes, zero-length salt. */
function hkdf32(ikm, info) {
    return hkdf(sha256, ikm, undefined, info, 32);
}
function isValidScalar(bytes) {
    const n = BigInt(`0x${bytesToHex(bytes)}`);
    return n > 0n && n < SECP256K1_N;
}
/**
 * A.3 `scalar_normalize`: first attempt carries no counter byte; on rejection
 * append one counter byte starting at 0. The reject branch is ~2⁻¹²⁸ rare, but
 * the counter keeps it deterministic across implementations.
 */
function hkdfToSecretKey(ikm, baseInfo) {
    const first = hkdf32(ikm, baseInfo);
    if (isValidScalar(first)) {
        return first;
    }
    for (let counter = 0; counter <= 255; counter += 1) {
        const candidate = hkdf32(ikm, concat(baseInfo, new Uint8Array([counter])));
        if (isValidScalar(candidate)) {
            return candidate;
        }
    }
    throw new Error('secp256k1 scalar rejection 257 times running is impossible');
}
// Two EC multiplications per derivation, re-paid for every held channel on
// every arriving wrap without this. Keyed by a digest so no secret sits in the
// map, and bounded so a flood of epochs resets it rather than growing it.
const memo = new Map();
function deriveGroupKey(label, secret, id32, epoch) {
    const info = buildInfo(label, id32, epoch);
    const memoKey = bytesToHex(sha256(concat(secret, new Uint8Array([epoch === undefined ? 0 : 1]), info)));
    const hit = memo.get(memoKey);
    if (hit) {
        return hit;
    }
    const sk = hkdfToSecretKey(secret, info);
    const pk = getPublicKey(sk);
    const key = { pk, sk, convKey: nip44.v2.utils.getConversationKey(sk, pk) };
    if (memo.size >= 1024) {
        memo.clear();
    }
    memo.set(memoKey, key);
    return key;
}
// ── Plane keys (CORD-02 §5, CORD-03 §1, CORD-06 §2) ─────────────────────────
/**
 * A channel's Chat Plane key. `secret` is the community root for a public
 * channel (at the root epoch) or the channel's own key for a private one (at
 * the channel's epoch).
 */
export function channelGroupKey(secret, channelId, epoch) {
    return deriveGroupKey(LABEL_CHANNEL, secret, channelId, epoch);
}
/**
 * The Control Plane's root-keyed key. Post-split this is only the plane's READ
 * key (its conv key decrypts every member's view); on a legacy pre-split epoch
 * its pk was also the address.
 */
export function controlGroupKey(communityRoot, communityId, epoch) {
    return deriveGroupKey(LABEL_CONTROL, communityRoot, communityId, epoch);
}
/** The Control Plane's staff-only signer (its pk is the plane's address post-split). */
export function controlSignerGroupKey(controlRoot, communityId, epoch) {
    return deriveGroupKey(LABEL_CONTROL_SIGNER, controlRoot, communityId, epoch);
}
/** The Guestbook Plane key: membership joins and leaves. */
export function guestbookGroupKey(communityRoot, communityId, epoch) {
    return deriveGroupKey(LABEL_GUESTBOOK, communityRoot, communityId, epoch);
}
/** A private channel's rekey address for `newEpoch`, keyed by the community root. */
export function channelRekeyGroupKey(root, channelId, newEpoch) {
    return deriveGroupKey(LABEL_REKEY_PSEUDONYM, root, channelId, newEpoch);
}
/** The base-rotation rekey address for `newEpoch`, keyed by the PRIOR root. */
export function baseRekeyGroupKey(priorRoot, communityId, newEpoch) {
    return deriveGroupKey(LABEL_BASE_REKEY_PSEUDONYM, priorRoot, communityId, newEpoch);
}
/** The dissolution tombstone key: from the community id alone, no key, no epoch. */
export function dissolvedGroupKey(communityId) {
    return deriveGroupKey(LABEL_DISSOLVED, communityId, ZERO32);
}
// ── A.4 / A.5 commitments ────────────────────────────────────────────────────
/** `community_id = sha256("concord/community" || owner_xonly || owner_salt)`. */
export function communityIdOf(ownerXonly, ownerSalt) {
    return sha256(concat(encoder.encode(LABEL_COMMUNITY), ownerXonly, ownerSalt));
}
/**
 * Whether a claimed `(owner, salt)` reproduces `communityId`. Every path that
 * trusts a claimed owner must pass this first.
 */
export function verifyCommunityId(communityId, owner, ownerSalt) {
    try {
        return bytesToHex(communityIdOf(bytes32(owner), bytes32(ownerSalt))) === communityId.toLowerCase();
    }
    catch {
        return false;
    }
}
/** `sha256("concord/epoch-key-commitment" || prev_epoch_be || prev_key)`: rekey continuity. */
export function epochKeyCommitment(prevEpoch, prevKey) {
    return sha256(concat(encoder.encode(LABEL_EPOCH_COMMITMENT), epochBytes(prevEpoch), prevKey));
}
