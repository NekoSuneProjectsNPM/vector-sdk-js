/**
 * Communities the bot has accepted an invite to.
 *
 * Accepting an invite is, at bottom, keeping what the bundle handed over: the
 * community's base access key, its epoch, and any channel keys. Those are the
 * credentials for everything the community does later, and they are exactly as
 * secret as the bot's own private key — so this store is written and protected
 * the same way.
 *
 * What this does **not** do is announce the join or read the channel. Both ride
 * the Concord v2 stream layer (HKDF-derived channel keys, the reversed seal/wrap
 * envelope, and consensus folding), which is not implemented in this package
 * yet. So a bot can accept, hold the keys, and be ready — but its membership is
 * not visible to the community and it cannot read or post until that lands.
 */
import { promises as fs } from 'fs';
import path from 'path';
/** Default filename used when a directory is given instead of a file. */
export const DEFAULT_COMMUNITIES_FILE = 'vector-bot-communities.json';
export class CommunityStoreError extends Error {
}
function resolveStorePath(target) {
    return path.extname(target) !== '' ? target : path.join(target, DEFAULT_COMMUNITIES_FILE);
}
/**
 * A file of accepted communities.
 *
 * Reads tolerate a missing or malformed file by returning nothing, so a bot
 * starts clean rather than refusing to run; writes are owner-only.
 */
export class CommunityStore {
    constructor(target = DEFAULT_COMMUNITIES_FILE) {
        this.filePath = resolveStorePath(target);
    }
    get path() {
        return this.filePath;
    }
    async all() {
        let raw;
        try {
            raw = await fs.readFile(this.filePath, 'utf8');
        }
        catch {
            return [];
        }
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed.communities) ? parsed.communities : [];
        }
        catch {
            // A corrupt store must not stop the bot; it is a cache of vended keys,
            // recoverable by re-accepting an invite.
            return [];
        }
    }
    async get(communityId) {
        return (await this.all()).find((c) => c.communityId === communityId);
    }
    async has(communityId) {
        return (await this.get(communityId)) !== undefined;
    }
    /**
     * Add or update a community.
     *
     * A re-accept replaces the stored entry, which is how a bot picks up rotated
     * keys or newly granted channels from a fresh invite.
     */
    async put(community) {
        const existing = await this.all();
        const index = existing.findIndex((c) => c.communityId === community.communityId);
        const next = [...existing];
        if (index >= 0) {
            next[index] = { ...existing[index], ...community };
        }
        else {
            next.push(community);
        }
        await this.write(next);
    }
    async remove(communityId) {
        const existing = await this.all();
        const next = existing.filter((c) => c.communityId !== communityId);
        if (next.length === existing.length) {
            return false;
        }
        await this.write(next);
        return true;
    }
    async write(communities) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const payload = { version: 1, communities };
        await fs.writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        try {
            await fs.chmod(this.filePath, 0o600);
        }
        catch {
            // Unsupported on this platform; the directory is the guard.
        }
    }
}
export class InviteRejected extends Error {
    constructor(reason, message) {
        super(message);
        this.reason = reason;
    }
}
/**
 * Turn a validated invite into the record of a joined community.
 *
 * Refuses an expired invite: past its deadline the preview still renders but
 * joining is not allowed, and the keys it carries are stale.
 */
export function communityFromInvite(invite, options) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (options.expiresAt !== undefined && options.expiresAt <= now) {
        throw new InviteRejected('expired', `The invite to ${invite.name || invite.communityId} expired at ${new Date(options.expiresAt * 1000).toISOString()}.`);
    }
    if (!invite.accessKey) {
        throw new InviteRejected('no-access-key', `The invite to ${invite.communityId} carries no access key, so there is nothing to accept.`);
    }
    return {
        communityId: invite.communityId,
        name: invite.name,
        protocol: invite.protocol,
        accessKey: invite.accessKey,
        epoch: invite.epoch,
        owner: invite.owner,
        ownerSalt: invite.ownerSalt,
        controlPk: invite.controlPk,
        relays: [...invite.relays],
        channels: invite.channels.map((channel) => ({ ...channel })),
        invitedBy: options.invitedBy,
        joinedAt: new Date().toISOString(),
        announced: false,
    };
}
// ── discord.js-shaped surface ────────────────────────────────────────────────
/**
 * A `Map` with the helpers discord.js's Collection provides.
 *
 * Only the handful that actually get used — enough that `communities.cache`
 * behaves the way someone coming from discord.js expects, without dragging in
 * a dependency for it.
 */
export class Collection extends Map {
    /** The first value, or undefined when empty. */
    first() {
        return this.values().next().value;
    }
    /** Every value, as an array. */
    toArray() {
        return [...this.values()];
    }
    find(predicate) {
        for (const [key, value] of this) {
            if (predicate(value, key)) {
                return value;
            }
        }
        return undefined;
    }
    filter(predicate) {
        return this.toArray().filter((value) => predicate(value, this.keyOf(value)));
    }
    map(fn) {
        return [...this].map(([key, value]) => fn(value, key));
    }
    keyOf(target) {
        for (const [key, value] of this) {
            if (value === target) {
                return key;
            }
        }
        return undefined;
    }
}
/**
 * A community the bot is in — the rough equivalent of a discord.js `Guild`.
 *
 * Carries the keys the invite vended, so it is a credential as much as a
 * description. Do not log one wholesale.
 */
export class Community {
    constructor(data, context) {
        this.data = data;
        this.context = context;
    }
    get id() {
        return this.data.communityId;
    }
    get name() {
        return this.data.name || this.data.communityId;
    }
    get protocol() {
        return this.data.protocol;
    }
    get epoch() {
        return this.data.epoch;
    }
    get relays() {
        return [...this.data.relays];
    }
    /** Channels the invite granted, each with its key where one was vended. */
    get channels() {
        return this.data.channels.map((channel) => ({ ...channel }));
    }
    /** Who invited the bot, hex. Seal-verified at the time, not a claim. */
    get invitedBy() {
        return this.data.invitedBy;
    }
    get joinedAt() {
        return new Date(this.data.joinedAt);
    }
    /**
     * Whether the community can see the bot.
     *
     * False until the join is announced on the guestbook, which needs the
     * Concord v2 stream layer. So a bot holds valid keys while remaining
     * invisible to the room.
     */
    get announced() {
        return this.data.announced;
    }
    /**
     * The members this bot can see — discord.js's `guild.members`, with the
     * caveat that it is partial. Read {@link CommunityMemberManager} before
     * showing a count.
     */
    get members() {
        if (!this.memberManager) {
            this.memberManager = new CommunityMemberManager(this, this.context.resolveUser);
        }
        return this.memberManager;
    }
    /** The stored record, keys included. */
    toJSON() {
        return { ...this.data };
    }
    /** Leave, discarding the stored keys. */
    async leave() {
        const removed = await this.context.store.remove(this.id);
        if (removed) {
            this.context.onLeave?.(this.id);
        }
        return removed;
    }
    toString() {
        return this.name;
    }
}
/**
 * The bot's communities — the rough equivalent of discord.js's
 * `client.guilds`.
 *
 * `cache` is filled by {@link fetch}, so a freshly built manager is empty until
 * something reads the store. That mirrors discord.js, where the cache reflects
 * what the client has actually seen.
 */
export class CommunityManager {
    constructor(store, onLeave, resolveUser) {
        this.store = store;
        this.onLeave = onLeave;
        this.resolveUser = resolveUser;
        this.cache = new Collection();
    }
    get size() {
        return this.cache.size;
    }
    /** Read the store and refresh the cache. */
    async fetch() {
        const all = await this.store.all();
        this.cache.clear();
        for (const data of all) {
            this.cache.set(data.communityId, new Community(data, {
                store: this.store,
                onLeave: this.onLeave,
                resolveUser: this.resolveUser,
            }));
        }
        return this.cache;
    }
    /** A community by id, from the cache. Call {@link fetch} first. */
    get(communityId) {
        return this.cache.get(communityId);
    }
    /** A community by id, reading the store when it is not cached. */
    async resolve(communityId) {
        const cached = this.cache.get(communityId);
        if (cached) {
            return cached;
        }
        const data = await this.store.get(communityId);
        if (!data) {
            return undefined;
        }
        const community = new Community(data, {
            store: this.store,
            onLeave: this.onLeave,
            resolveUser: this.resolveUser,
        });
        this.cache.set(communityId, community);
        return community;
    }
    /** Leave by id. */
    async leave(communityId) {
        const community = await this.resolve(communityId);
        if (!community) {
            return false;
        }
        const left = await community.leave();
        if (left) {
            this.cache.delete(communityId);
        }
        return left;
    }
}
/**
 * The members of a community that this bot can actually see.
 *
 * **This is not the full member list, and it cannot be.** The complete roster
 * lives in the community's Guestbook, which is sealed under a key derived from
 * the community secret — reading it needs the Concord v2 stream layer, which
 * this package does not implement. What is knowable without it:
 *
 * - the **owner**, whose pubkey is in the invite bundle and which the community
 *   id is a hash commitment to, so it is self-certifying;
 * - the **inviter**, taken from the verified seal on the invite;
 * - anyone **observed** — accounts the bot has actually exchanged messages
 *   with in this community's context.
 *
 * {@link complete} is `false` to say so plainly, rather than letting a short
 * list read as a small community.
 */
export class CommunityMemberManager {
    constructor(community, resolveUser) {
        this.community = community;
        this.resolveUser = resolveUser;
        this.observed = new Set();
    }
    /**
     * Whether this list is the community's real membership.
     *
     * Always false today. Check it before showing a count.
     */
    get complete() {
        return false;
    }
    /** The owner's pubkey, hex, when the bundle named one. */
    get ownerId() {
        return this.community.toJSON().owner;
    }
    /** Record someone seen acting in this community. */
    observe(pubkey) {
        const owner = this.ownerId;
        if (pubkey && pubkey !== owner && pubkey !== this.community.invitedBy) {
            this.observed.add(pubkey);
        }
    }
    /** Every member the bot knows about, without fetching profiles. */
    list() {
        const owner = this.ownerId;
        const out = [];
        const seen = new Set();
        const push = (pubkey, source) => {
            if (!pubkey || seen.has(pubkey)) {
                return;
            }
            seen.add(pubkey);
            out.push({ pubkey, source, isOwner: pubkey === owner });
        };
        push(owner, 'owner');
        push(this.community.invitedBy, 'inviter');
        for (const pubkey of this.observed) {
            push(pubkey, 'observed');
        }
        return out;
    }
    /** Every known member, with their profiles fetched. */
    async fetch() {
        const members = this.list();
        if (!this.resolveUser) {
            return members;
        }
        return Promise.all(members.map(async (member) => ({
            ...member,
            user: await this.resolveUser(member.pubkey),
        })));
    }
    /** How many members the bot knows about. Not the community's size. */
    get size() {
        return this.list().length;
    }
}
