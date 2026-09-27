/**
 * Users and their profiles — the rough equivalent of discord.js's `User` and
 * `client.users`.
 *
 * A Nostr profile is a kind-0 event the account publishes about itself. It is
 * self-asserted: anyone can claim any `name` or `picture`. The only field that
 * means anything on its own is the pubkey, and the only claim that can be
 * checked is `nip05`, which points at a domain that must name the key back.
 */
import { nip19 } from 'nostr-tools';
import { normalizePublicKey } from './keys.js';
import { Collection } from './communities.js';
/** How long to wait on relays for a profile lookup. */
const FETCH_TIMEOUT_MS = 4000;
/** How long a fetched profile is trusted before it is looked up again. */
export const PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
/**
 * Read a kind-0 event's content into profile fields.
 *
 * Tolerant by design: a profile is arbitrary JSON from a stranger, so a
 * malformed one yields empty fields rather than throwing and taking out
 * whatever was rendering it.
 */
export function parseProfile(event) {
    if (!event || event.kind !== 0 || !event.content) {
        return {};
    }
    let raw;
    try {
        raw = JSON.parse(event.content);
    }
    catch {
        return {};
    }
    const str = (value) => typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : undefined;
    return {
        name: str(raw.name),
        // Clients have written both spellings for years; read either.
        displayName: str(raw.display_name) ?? str(raw.displayName),
        about: str(raw.about),
        picture: str(raw.picture),
        banner: str(raw.banner),
        nip05: str(raw.nip05),
        lud16: str(raw.lud16),
        website: str(raw.website),
        bot: raw.bot === true,
    };
}
/**
 * One account: its key, its self-asserted profile, and what you can do with it.
 */
export class User {
    constructor(
    /** Public key, hex. The only part of a user that is not a claim. */
    pubkey, profile, context, 
    /** When the profile was fetched; undefined means it was never found. */
    fetchedAt) {
        this.pubkey = pubkey;
        this.profile = profile;
        this.context = context;
        this.fetchedAt = fetchedAt;
    }
    /** Public key, bech32. */
    get npub() {
        return nip19.npubEncode(this.pubkey);
    }
    /**
     * The best name to show: the display name, the handle, else a short npub.
     *
     * Never empty, so callers can render it without a fallback of their own.
     */
    get displayName() {
        return (this.profile.displayName ||
            this.profile.name ||
            `${this.npub.slice(0, 12)}…`);
    }
    /** The handle, when the account set one. */
    get username() {
        return this.profile.name;
    }
    get about() {
        return this.profile.about;
    }
    /** Avatar URL. Unverified — it is whatever the account put there. */
    get avatarURL() {
        return this.profile.picture;
    }
    get bannerURL() {
        return this.profile.banner;
    }
    /**
     * The account's NIP-05 identifier, e.g. `alice@example.com`.
     *
     * A *claim*. Confirming it means asking that domain whether it names this
     * pubkey back — see {@link verifyNip05}.
     */
    get nip05() {
        return this.profile.nip05;
    }
    /** Lightning address. */
    get lud16() {
        return this.profile.lud16;
    }
    /** Whether the account flags itself as a bot. Self-asserted. */
    get bot() {
        return this.profile.bot === true;
    }
    /** Whether a profile was ever found for this key. */
    get known() {
        return this.fetchedAt !== undefined;
    }
    /** The raw profile fields. */
    toJSON() {
        return { ...this.profile, pubkey: this.pubkey, npub: this.npub };
    }
    /** Replace the cached profile, e.g. after a refetch. */
    patch(profile, fetchedAt = Date.now()) {
        this.profile = profile;
        this.fetchedAt = fetchedAt;
        return this;
    }
    /**
     * Check the NIP-05 claim against the domain it names.
     *
     * Resolves `name@domain` to `https://domain/.well-known/nostr.json?name=…`
     * and confirms the domain maps that name to this pubkey. Returns false on any
     * failure — unreachable, malformed, or simply not matching — because an
     * unverifiable claim and a false one are the same thing to a caller.
     */
    async verifyNip05() {
        const identifier = this.profile.nip05;
        if (!identifier || !identifier.includes('@')) {
            return false;
        }
        const [name, domain] = identifier.split('@');
        if (!name || !domain) {
            return false;
        }
        try {
            const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
            const response = await fetch(url);
            if (!response.ok) {
                return false;
            }
            const payload = (await response.json());
            return payload.names?.[name]?.toLowerCase() === this.pubkey.toLowerCase();
        }
        catch {
            return false;
        }
    }
    /** Send this user a direct message. */
    async send(content) {
        if (!this.context.send) {
            throw new Error('This User was built without a send function');
        }
        return this.context.send(this.pubkey, content);
    }
    /** The relays this user wants gift wraps delivered to (NIP-17 kind 10050). */
    async dmRelays() {
        return this.context.client.inboxRelays.resolve(this.pubkey);
    }
    toString() {
        return this.displayName;
    }
}
/**
 * Profile lookups with a cache — the rough equivalent of `client.users`.
 *
 * Misses are cached too: an account with no published profile is ordinary, and
 * re-querying every relay each time it is mentioned costs far more than the
 * empty result is worth.
 */
export class UserManager {
    constructor(client, sendFn, ttlMs = PROFILE_CACHE_TTL_MS) {
        this.client = client;
        this.sendFn = sendFn;
        this.ttlMs = ttlMs;
        this.cache = new Collection();
    }
    get relays() {
        return Array.from(new Set([...this.client.relays, ...this.client.discoveryRelays]));
    }
    context() {
        return { client: this.client, send: this.sendFn };
    }
    /** A cached user, without touching the network. */
    get(user) {
        try {
            return this.cache.get(normalizePublicKey(user));
        }
        catch {
            return undefined;
        }
    }
    /**
     * Fetch a user's profile, from cache when it is fresh.
     *
     * `force` re-queries regardless of the cache.
     */
    async fetch(user, options = {}) {
        const pubkey = normalizePublicKey(user);
        const cached = this.cache.get(pubkey);
        if (cached &&
            !options.force &&
            cached.fetchedAt !== undefined &&
            Date.now() - cached.fetchedAt < this.ttlMs) {
            return cached;
        }
        const filter = { kinds: [0], authors: [pubkey], limit: 1 };
        let event = null;
        try {
            event = await Promise.race([
                this.client.pool.get(this.relays, filter),
                new Promise((resolve) => {
                    setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);
                }),
            ]);
        }
        catch {
            event = null;
        }
        const profile = parseProfile(event);
        // A miss still caches, as a User with no fetchedAt, so `known` stays false
        // while the TTL keeps the lookup from repeating on every mention.
        const existing = this.cache.get(pubkey);
        if (existing) {
            existing.patch(profile, event ? Date.now() : existing.fetchedAt);
            return existing;
        }
        const built = new User(pubkey, profile, this.context(), event ? Date.now() : undefined);
        this.cache.set(pubkey, built);
        return built;
    }
    /**
     * Fetch several profiles in one relay query.
     *
     * Cheaper than a fetch per key — one REQ covers the set, which matters when
     * rendering a list of people.
     */
    async fetchMany(users) {
        const pubkeys = Array.from(new Set(users
            .map((user) => {
            try {
                return normalizePublicKey(user);
            }
            catch {
                return null;
            }
        })
            .filter((value) => value !== null)));
        const out = new Collection();
        if (!pubkeys.length) {
            return out;
        }
        let events = [];
        try {
            events = await this.client.pool.querySync(this.relays, { kinds: [0], authors: pubkeys, limit: pubkeys.length * 2 }, { maxWait: FETCH_TIMEOUT_MS });
        }
        catch {
            events = [];
        }
        // Relays can hand back several profiles per author; the newest wins.
        const newest = new Map();
        for (const event of events) {
            const held = newest.get(event.pubkey);
            if (!held || held.created_at < event.created_at) {
                newest.set(event.pubkey, event);
            }
        }
        for (const pubkey of pubkeys) {
            const event = newest.get(pubkey) ?? null;
            const profile = parseProfile(event);
            const existing = this.cache.get(pubkey);
            const user = existing
                ? existing.patch(profile, event ? Date.now() : existing.fetchedAt)
                : new User(pubkey, profile, this.context(), event ? Date.now() : undefined);
            this.cache.set(pubkey, user);
            out.set(pubkey, user);
        }
        return out;
    }
    /** Drop a cached profile so the next fetch re-queries. */
    invalidate(user) {
        try {
            this.cache.delete(normalizePublicKey(user));
        }
        catch {
            // Not a key we could have cached.
        }
    }
}
