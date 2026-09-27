/**
 * Users and their profiles — the rough equivalent of discord.js's `User` and
 * `client.users`.
 *
 * A Nostr profile is a kind-0 event the account publishes about itself. It is
 * self-asserted: anyone can claim any `name` or `picture`. The only field that
 * means anything on its own is the pubkey, and the only claim that can be
 * checked is `nip05`, which points at a domain that must name the key back.
 */
import type { Event } from 'nostr-tools';
import type { VectorClient } from './client.js';
import { Collection } from './communities.js';
/** How long a fetched profile is trusted before it is looked up again. */
export declare const PROFILE_CACHE_TTL_MS: number;
/** The fields a kind-0 profile may carry. All self-asserted. */
export interface ProfileFields {
    name?: string;
    displayName?: string;
    about?: string;
    picture?: string;
    banner?: string;
    nip05?: string;
    lud16?: string;
    website?: string;
    /** The account says it is a bot. A claim, not a guarantee. */
    bot?: boolean;
}
/**
 * Read a kind-0 event's content into profile fields.
 *
 * Tolerant by design: a profile is arbitrary JSON from a stranger, so a
 * malformed one yields empty fields rather than throwing and taking out
 * whatever was rendering it.
 */
export declare function parseProfile(event: Event | null | undefined): ProfileFields;
/** What a {@link User} needs from its client to act. */
export interface UserContext {
    client: VectorClient;
    send?: (pubkey: string, content: string) => Promise<unknown>;
}
/**
 * One account: its key, its self-asserted profile, and what you can do with it.
 */
export declare class User {
    /** Public key, hex. The only part of a user that is not a claim. */
    readonly pubkey: string;
    private profile;
    private readonly context;
    /** When the profile was fetched; undefined means it was never found. */
    fetchedAt?: number | undefined;
    constructor(
    /** Public key, hex. The only part of a user that is not a claim. */
    pubkey: string, profile: ProfileFields, context: UserContext, 
    /** When the profile was fetched; undefined means it was never found. */
    fetchedAt?: number | undefined);
    /** Public key, bech32. */
    get npub(): string;
    /**
     * The best name to show: the display name, the handle, else a short npub.
     *
     * Never empty, so callers can render it without a fallback of their own.
     */
    get displayName(): string;
    /** The handle, when the account set one. */
    get username(): string | undefined;
    get about(): string | undefined;
    /** Avatar URL. Unverified — it is whatever the account put there. */
    get avatarURL(): string | undefined;
    get bannerURL(): string | undefined;
    /**
     * The account's NIP-05 identifier, e.g. `alice@example.com`.
     *
     * A *claim*. Confirming it means asking that domain whether it names this
     * pubkey back — see {@link verifyNip05}.
     */
    get nip05(): string | undefined;
    /** Lightning address. */
    get lud16(): string | undefined;
    /** Whether the account flags itself as a bot. Self-asserted. */
    get bot(): boolean;
    /** Whether a profile was ever found for this key. */
    get known(): boolean;
    /** The raw profile fields. */
    toJSON(): ProfileFields & {
        pubkey: string;
        npub: string;
    };
    /** Replace the cached profile, e.g. after a refetch. */
    patch(profile: ProfileFields, fetchedAt?: number): this;
    /**
     * Check the NIP-05 claim against the domain it names.
     *
     * Resolves `name@domain` to `https://domain/.well-known/nostr.json?name=…`
     * and confirms the domain maps that name to this pubkey. Returns false on any
     * failure — unreachable, malformed, or simply not matching — because an
     * unverifiable claim and a false one are the same thing to a caller.
     */
    verifyNip05(): Promise<boolean>;
    /** Send this user a direct message. */
    send(content: string): Promise<unknown>;
    /** The relays this user wants gift wraps delivered to (NIP-17 kind 10050). */
    dmRelays(): Promise<string[]>;
    toString(): string;
}
/**
 * Profile lookups with a cache — the rough equivalent of `client.users`.
 *
 * Misses are cached too: an account with no published profile is ordinary, and
 * re-querying every relay each time it is mentioned costs far more than the
 * empty result is worth.
 */
export declare class UserManager {
    private readonly client;
    private readonly sendFn?;
    private readonly ttlMs;
    readonly cache: Collection<string, User>;
    constructor(client: VectorClient, sendFn?: ((pubkey: string, content: string) => Promise<unknown>) | undefined, ttlMs?: number);
    private get relays();
    private context;
    /** A cached user, without touching the network. */
    get(user: string): User | undefined;
    /**
     * Fetch a user's profile, from cache when it is fresh.
     *
     * `force` re-queries regardless of the cache.
     */
    fetch(user: string, options?: {
        force?: boolean;
    }): Promise<User>;
    /**
     * Fetch several profiles in one relay query.
     *
     * Cheaper than a fetch per key — one REQ covers the set, which matters when
     * rendering a list of people.
     */
    fetchMany(users: string[]): Promise<Collection<string, User>>;
    /** Drop a cached profile so the next fetch re-queries. */
    invalidate(user: string): void;
}
