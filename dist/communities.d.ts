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
import type { CommunityInvite, InviteChannel, InviteProtocol } from './invites.js';
/** Default filename used when a directory is given instead of a file. */
export declare const DEFAULT_COMMUNITIES_FILE = "vector-bot-communities.json";
export declare class CommunityStoreError extends Error {
}
/** A community the bot has accepted, with the keys the invite vended. */
export interface JoinedCommunity {
    communityId: string;
    name: string;
    protocol: InviteProtocol;
    /** Base access key. SECRET. */
    accessKey: string;
    epoch: number;
    owner?: string;
    ownerSalt?: string;
    controlPk?: string;
    relays: string[];
    /** Channel grants, each with its own key where the invite vended one. SECRET. */
    channels: InviteChannel[];
    /** Who invited the bot, hex — the seal-verified sender, not a claim. */
    invitedBy: string;
    /** When the invite was accepted, ISO 8601. */
    joinedAt: string;
    /**
     * False until the bot has announced itself to the community's guestbook.
     *
     * Always false today: announcing needs the v2 stream layer. Recorded so a
     * later release can find the communities still owing an announcement rather
     * than silently treating them as fully joined.
     */
    announced: boolean;
}
/**
 * A file of accepted communities.
 *
 * Reads tolerate a missing or malformed file by returning nothing, so a bot
 * starts clean rather than refusing to run; writes are owner-only.
 */
export declare class CommunityStore {
    private readonly filePath;
    constructor(target?: string);
    get path(): string;
    all(): Promise<JoinedCommunity[]>;
    get(communityId: string): Promise<JoinedCommunity | undefined>;
    has(communityId: string): Promise<boolean>;
    /**
     * Add or update a community.
     *
     * A re-accept replaces the stored entry, which is how a bot picks up rotated
     * keys or newly granted channels from a fresh invite.
     */
    put(community: JoinedCommunity): Promise<void>;
    remove(communityId: string): Promise<boolean>;
    private write;
}
/** Why an invite could not be accepted. */
export type AcceptRefusal = 'expired' | 'no-access-key';
export declare class InviteRejected extends Error {
    readonly reason: AcceptRefusal;
    constructor(reason: AcceptRefusal, message: string);
}
/**
 * Turn a validated invite into the record of a joined community.
 *
 * Refuses an expired invite: past its deadline the preview still renders but
 * joining is not allowed, and the keys it carries are stale.
 */
export declare function communityFromInvite(invite: CommunityInvite, options: {
    invitedBy: string;
    expiresAt?: number;
    now?: number;
}): JoinedCommunity;
/**
 * A `Map` with the helpers discord.js's Collection provides.
 *
 * Only the handful that actually get used — enough that `communities.cache`
 * behaves the way someone coming from discord.js expects, without dragging in
 * a dependency for it.
 */
export declare class Collection<K, V> extends Map<K, V> {
    /** The first value, or undefined when empty. */
    first(): V | undefined;
    /** Every value, as an array. */
    toArray(): V[];
    find(predicate: (value: V, key: K) => boolean): V | undefined;
    filter(predicate: (value: V, key: K) => boolean): V[];
    map<T>(fn: (value: V, key: K) => T): T[];
    private keyOf;
}
/** What a {@link Community} needs from its client to act on itself. */
export interface CommunityContext {
    store: CommunityStore;
    onLeave?: (communityId: string) => void;
}
/**
 * A community the bot is in — the rough equivalent of a discord.js `Guild`.
 *
 * Carries the keys the invite vended, so it is a credential as much as a
 * description. Do not log one wholesale.
 */
export declare class Community {
    private readonly data;
    private readonly context;
    constructor(data: JoinedCommunity, context: CommunityContext);
    get id(): string;
    get name(): string;
    get protocol(): InviteProtocol;
    get epoch(): number;
    get relays(): string[];
    /** Channels the invite granted, each with its key where one was vended. */
    get channels(): InviteChannel[];
    /** Who invited the bot, hex. Seal-verified at the time, not a claim. */
    get invitedBy(): string;
    get joinedAt(): Date;
    /**
     * Whether the community can see the bot.
     *
     * False until the join is announced on the guestbook, which needs the
     * Concord v2 stream layer. So a bot holds valid keys while remaining
     * invisible to the room.
     */
    get announced(): boolean;
    /** The stored record, keys included. */
    toJSON(): JoinedCommunity;
    /** Leave, discarding the stored keys. */
    leave(): Promise<boolean>;
    toString(): string;
}
/**
 * The bot's communities — the rough equivalent of discord.js's
 * `client.guilds`.
 *
 * `cache` is filled by {@link fetch}, so a freshly built manager is empty until
 * something reads the store. That mirrors discord.js, where the cache reflects
 * what the client has actually seen.
 */
export declare class CommunityManager {
    private readonly store;
    private readonly onLeave?;
    readonly cache: Collection<string, Community>;
    constructor(store: CommunityStore, onLeave?: ((communityId: string) => void) | undefined);
    get size(): number;
    /** Read the store and refresh the cache. */
    fetch(): Promise<Collection<string, Community>>;
    /** A community by id, from the cache. Call {@link fetch} first. */
    get(communityId: string): Community | undefined;
    /** A community by id, reading the store when it is not cached. */
    resolve(communityId: string): Promise<Community | undefined>;
    /** Leave by id. */
    leave(communityId: string): Promise<boolean>;
}
