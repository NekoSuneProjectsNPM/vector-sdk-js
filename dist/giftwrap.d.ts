import type { Event, UnsignedEvent } from 'nostr-tools';
/** A NIP-59 rumor: an unsigned event that carries its own id. */
export type Rumor = UnsignedEvent & {
    id: string;
};
/** Build a rumor (unsigned, id-bearing) from a partial event. */
export declare function createRumor(event: Partial<UnsignedEvent>, privateKey: Uint8Array): Rumor;
/** Seal a rumor to `recipientPublicKey` (NIP-59 kind 13). */
export declare function createSeal(rumor: Rumor, privateKey: Uint8Array, recipientPublicKey: string): Event;
/**
 * Wrap a seal for `recipientPublicKey` under a throwaway key (NIP-59 kind 1059).
 *
 * `extraTags` land on the outer wrap alongside the `p` tag. Vector uses this to
 * mirror a rumor's NIP-40 `expiration` onto the wrap, so relays purge the
 * envelope on schedule rather than holding it until a client asks.
 */
export declare function createWrap(seal: Event, recipientPublicKey: string, extraTags?: string[][]): Event;
/**
 * Gift-wrap `event` for `recipientPublicKey`, returning the wrap and the rumor
 * it carries.
 *
 * The rumor's id is the message's durable identity — it is what a reply, edit,
 * reaction or deletion references, so callers need it back. `nostr-tools`'
 * `wrapEvent` discards it.
 */
export declare function wrapEventWithRumor(event: Partial<UnsignedEvent>, senderPrivateKey: Uint8Array, recipientPublicKey: string, extraTags?: string[][]): {
    wrap: Event;
    rumor: Rumor;
};
/**
 * Re-wrap an existing rumor for a second recipient.
 *
 * Used for the self-wrap: Vector sends every outgoing message a second time,
 * addressed to the sender, so the account's other devices see what this one
 * sent. The rumor — and therefore the message id — is identical in both wraps.
 */
export declare function rewrapRumor(rumor: Rumor, senderPrivateKey: Uint8Array, recipientPublicKey: string, extraTags?: string[][]): Event;
export declare class GiftWrapError extends Error {
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
export declare function unwrapGiftWrap(wrap: Event, recipientPrivateKey: Uint8Array): Rumor;
/** Pull the NIP-40 `expiration` tag off a rumor, if it carries one. */
export declare function expirationTagsOf(tags: string[][]): string[][];
