import { nip44, verifyEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { GIFT_WRAP, SEAL } from './kinds.js';
const TWO_DAYS = 2 * 24 * 60 * 60;
const nowSeconds = () => Math.round(Date.now() / 1000);
/**
 * Timestamp jitter for seals and wraps: up to two days in the past, so the
 * outer event leaks nothing about when the rumor was actually written.
 */
const jitteredNow = () => Math.round(nowSeconds() - Math.random() * TWO_DAYS);
/** Build a rumor (unsigned, id-bearing) from a partial event. */
export function createRumor(event, privateKey) {
    const rumor = {
        created_at: nowSeconds(),
        content: '',
        tags: [],
        ...event,
        pubkey: getPublicKey(privateKey),
    };
    rumor.id = getEventHash(rumor);
    return rumor;
}
/** Seal a rumor to `recipientPublicKey` (NIP-59 kind 13). */
export function createSeal(rumor, privateKey, recipientPublicKey) {
    const conversationKey = nip44.v2.utils.getConversationKey(privateKey, recipientPublicKey);
    return finalizeEvent({
        kind: SEAL,
        content: nip44.v2.encrypt(JSON.stringify(rumor), conversationKey),
        created_at: jitteredNow(),
        tags: [],
    }, privateKey);
}
/**
 * Wrap a seal for `recipientPublicKey` under a throwaway key (NIP-59 kind 1059).
 *
 * `extraTags` land on the outer wrap alongside the `p` tag. Vector uses this to
 * mirror a rumor's NIP-40 `expiration` onto the wrap, so relays purge the
 * envelope on schedule rather than holding it until a client asks.
 */
export function createWrap(seal, recipientPublicKey, extraTags = []) {
    const randomKey = generateSecretKey();
    const conversationKey = nip44.v2.utils.getConversationKey(randomKey, recipientPublicKey);
    return finalizeEvent({
        kind: GIFT_WRAP,
        content: nip44.v2.encrypt(JSON.stringify(seal), conversationKey),
        created_at: jitteredNow(),
        tags: [['p', recipientPublicKey], ...extraTags],
    }, randomKey);
}
/**
 * Gift-wrap `event` for `recipientPublicKey`, returning the wrap and the rumor
 * it carries.
 *
 * The rumor's id is the message's durable identity — it is what a reply, edit,
 * reaction or deletion references, so callers need it back. `nostr-tools`'
 * `wrapEvent` discards it.
 */
export function wrapEventWithRumor(event, senderPrivateKey, recipientPublicKey, extraTags = []) {
    const rumor = createRumor(event, senderPrivateKey);
    const seal = createSeal(rumor, senderPrivateKey, recipientPublicKey);
    return { wrap: createWrap(seal, recipientPublicKey, extraTags), rumor };
}
/**
 * Re-wrap an existing rumor for a second recipient.
 *
 * Used for the self-wrap: Vector sends every outgoing message a second time,
 * addressed to the sender, so the account's other devices see what this one
 * sent. The rumor — and therefore the message id — is identical in both wraps.
 */
export function rewrapRumor(rumor, senderPrivateKey, recipientPublicKey, extraTags = []) {
    const seal = createSeal(rumor, senderPrivateKey, recipientPublicKey);
    return createWrap(seal, recipientPublicKey, extraTags);
}
export class GiftWrapError extends Error {
}
/**
 * Unwrap a gift wrap **and authenticate who sent it**.
 *
 * A NIP-59 rumor is unsigned — the signature lives on the kind-13 seal — so the
 * rumor's `pubkey` field is a claim, not proof. Verifying the seal and checking
 * that the rumor agrees with it is the only thing that establishes the sender.
 *
 * `nostr-tools`' own `unwrapEvent` skips both checks, which lets anyone seal a
 * rumor attributed to someone else and have it come back under that name. A bot
 * that authorizes on sender would hand an attacker whatever the impersonated
 * account can do, so unwrapping without this is not safe.
 *
 * Throws rather than returning null: a wrap that fails these checks is a forgery
 * attempt or corruption, never something to quietly treat as an ordinary message.
 */
export function unwrapGiftWrap(wrap, recipientPrivateKey) {
    if (wrap.kind !== GIFT_WRAP) {
        throw new GiftWrapError(`Not a gift wrap (kind ${wrap.kind})`);
    }
    // wrap → seal, under the ephemeral wrap author's key.
    const wrapKey = nip44.v2.utils.getConversationKey(recipientPrivateKey, wrap.pubkey);
    let seal;
    try {
        seal = JSON.parse(nip44.v2.decrypt(wrap.content, wrapKey));
    }
    catch (error) {
        throw new GiftWrapError(`Could not open the gift wrap: ${String(error)}`);
    }
    if (seal.kind !== SEAL) {
        throw new GiftWrapError(`Gift wrap did not contain a seal (kind ${seal.kind})`);
    }
    // The seal's signature is the sender's only proof of authorship.
    if (!verifyEvent(seal)) {
        throw new GiftWrapError('Seal signature is invalid — the sender cannot be trusted');
    }
    // seal → rumor, under the real sender's key.
    const sealKey = nip44.v2.utils.getConversationKey(recipientPrivateKey, seal.pubkey);
    let rumor;
    try {
        rumor = JSON.parse(nip44.v2.decrypt(seal.content, sealKey));
    }
    catch (error) {
        throw new GiftWrapError(`Could not open the seal: ${String(error)}`);
    }
    // The rumor names its own author. If that disagrees with who signed the seal,
    // someone is claiming to be someone else.
    if (rumor.pubkey !== seal.pubkey) {
        throw new GiftWrapError(`Rumor claims to be from ${rumor.pubkey.slice(0, 16)}… but the seal was signed by ${seal.pubkey.slice(0, 16)}…`);
    }
    // The id is what replies, reactions and deletions reference, so a wrong one
    // would let a sender point those at an event they did not write.
    const expectedId = getEventHash(rumor);
    if (rumor.id !== expectedId) {
        throw new GiftWrapError('Rumor id does not match its contents');
    }
    return rumor;
}
/** Pull the NIP-40 `expiration` tag off a rumor, if it carries one. */
export function expirationTagsOf(tags) {
    return tags.filter((tag) => tag[0] === 'expiration' && typeof tag[1] === 'string');
}
