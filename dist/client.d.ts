import { SimplePool, Event } from 'nostr-tools';
import type { Metadata } from './metadata.js';
import { InboxRelayResolver } from './inbox-relays.js';
export interface ClientConfig {
    proxy?: string;
    defaultRelays?: string[];
    publishRetries?: number;
    /**
     * Also send DMs as NIP-04 (kind 4) alongside the gift wrap.
     *
     * Vector dropped NIP-04 entirely and ignores kind 4, so this is off by
     * default. Turn it on only to reach a client that still speaks it.
     */
    legacyNip04?: boolean;
    /**
     * Send every outgoing message a second time, gift-wrapped to the bot itself,
     * so the account's other devices see what this one sent. Matches Vector. On
     * by default.
     */
    selfWrap?: boolean;
    /**
     * Deliver gift wraps to the recipient's published NIP-17 inbox relays
     * (kind 10050) rather than only the bot's own relay set. On by default.
     */
    useInboxRelays?: boolean;
    /**
     * Relays queried for inbox lists and bot manifests, on top of the bot's own.
     * Defaults to {@link DISCOVERY_RELAYS}.
     */
    discoveryRelays?: string[];
}
export declare class VectorClient {
    readonly pool: SimplePool;
    readonly relays: string[];
    readonly discoveryRelays: string[];
    readonly publicKey: string;
    readonly privateKey: string;
    readonly privateKeyBytes: Uint8Array;
    readonly legacyNip04: boolean;
    readonly selfWrap: boolean;
    readonly useInboxRelays: boolean;
    readonly inboxRelays: InboxRelayResolver;
    private readonly publishRetries;
    constructor(keys: string, config?: ClientConfig);
    /**
     * Fetch this account's currently published profile, if it has one.
     *
     * Kind 0 is replaceable, so this is the whole profile — there is no partial
     * update on the wire, and publishing replaces everything.
     */
    fetchOwnProfile(): Promise<Record<string, unknown> | null>;
    /**
     * Publish this account's profile.
     *
     * Kind 0 replaces wholesale, so publishing a partial profile *erases*
     * everything left out. `merge` (the default) reads what is already published
     * and writes the new fields over it, which is what stops a bot connecting
     * with a human's key from wiping that person's name, picture and bio.
     */
    setMetadata(metadata: Metadata, options?: {
        merge?: boolean;
    }): Promise<void>;
    /**
     * Publish the account's existing profile with `bot` set explicitly.
     *
     * Vector only re-evaluates its badge when the `bot` field is present, so an
     * account wrongly flagged cannot be cleared by removing the field — the flag
     * simply persists. Writing `bot: false` is the only thing that clears it.
     *
     * Every other field is carried over untouched.
     */
    setBotFlag(bot: boolean): Promise<Record<string, unknown>>;
    /**
     * Publish this bot's own NIP-17 inbox relay list, so other clients know where
     * to deliver its gift wraps instead of guessing.
     */
    publishInboxRelayList(relays?: string[]): Promise<void>;
    publishEvent(event: Event, relays?: string[]): Promise<void>;
    /**
     * Publish a gift wrap to where `recipientPubkey` actually looks for it.
     *
     * The recipient's inbox relays are used when it publishes a kind 10050 and
     * {@link useInboxRelays} is on; otherwise this falls back to the bot's own
     * relays, which is also where the send lands if the lookup finds nothing.
     */
    publishGiftWrap(event: Event, recipientPubkey: string): Promise<void>;
    private publish;
}
export declare function buildClient(keys: string, config?: ClientConfig): VectorClient;
