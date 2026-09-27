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

import type { CommunityInvite, InviteChannel, InviteProtocol } from './invites.js';

/** Default filename used when a directory is given instead of a file. */
export const DEFAULT_COMMUNITIES_FILE = 'vector-bot-communities.json';

export class CommunityStoreError extends Error {}

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

function resolveStorePath(target: string): string {
  return path.extname(target) !== '' ? target : path.join(target, DEFAULT_COMMUNITIES_FILE);
}

/**
 * A file of accepted communities.
 *
 * Reads tolerate a missing or malformed file by returning nothing, so a bot
 * starts clean rather than refusing to run; writes are owner-only.
 */
export class CommunityStore {
  private readonly filePath: string;

  constructor(target: string = DEFAULT_COMMUNITIES_FILE) {
    this.filePath = resolveStorePath(target);
  }

  public get path(): string {
    return this.filePath;
  }

  public async all(): Promise<JoinedCommunity[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as { communities?: JoinedCommunity[] };
      return Array.isArray(parsed.communities) ? parsed.communities : [];
    } catch {
      // A corrupt store must not stop the bot; it is a cache of vended keys,
      // recoverable by re-accepting an invite.
      return [];
    }
  }

  public async get(communityId: string): Promise<JoinedCommunity | undefined> {
    return (await this.all()).find((c) => c.communityId === communityId);
  }

  public async has(communityId: string): Promise<boolean> {
    return (await this.get(communityId)) !== undefined;
  }

  /**
   * Add or update a community.
   *
   * A re-accept replaces the stored entry, which is how a bot picks up rotated
   * keys or newly granted channels from a fresh invite.
   */
  public async put(community: JoinedCommunity): Promise<void> {
    const existing = await this.all();
    const index = existing.findIndex((c) => c.communityId === community.communityId);
    const next = [...existing];
    if (index >= 0) {
      next[index] = { ...existing[index], ...community };
    } else {
      next.push(community);
    }
    await this.write(next);
  }

  public async remove(communityId: string): Promise<boolean> {
    const existing = await this.all();
    const next = existing.filter((c) => c.communityId !== communityId);
    if (next.length === existing.length) {
      return false;
    }
    await this.write(next);
    return true;
  }

  private async write(communities: JoinedCommunity[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = { version: 1, communities };
    await fs.writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await fs.chmod(this.filePath, 0o600);
    } catch {
      // Unsupported on this platform; the directory is the guard.
    }
  }
}

/** Why an invite could not be accepted. */
export type AcceptRefusal = 'expired' | 'no-access-key';

export class InviteRejected extends Error {
  constructor(
    public readonly reason: AcceptRefusal,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Turn a validated invite into the record of a joined community.
 *
 * Refuses an expired invite: past its deadline the preview still renders but
 * joining is not allowed, and the keys it carries are stale.
 */
export function communityFromInvite(
  invite: CommunityInvite,
  options: { invitedBy: string; expiresAt?: number; now?: number },
): JoinedCommunity {
  const now = options.now ?? Math.floor(Date.now() / 1000);

  if (options.expiresAt !== undefined && options.expiresAt <= now) {
    throw new InviteRejected(
      'expired',
      `The invite to ${invite.name || invite.communityId} expired at ${new Date(options.expiresAt * 1000).toISOString()}.`,
    );
  }
  if (!invite.accessKey) {
    throw new InviteRejected(
      'no-access-key',
      `The invite to ${invite.communityId} carries no access key, so there is nothing to accept.`,
    );
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
export class Collection<K, V> extends Map<K, V> {
  /** The first value, or undefined when empty. */
  public first(): V | undefined {
    return this.values().next().value;
  }

  /** Every value, as an array. */
  public toArray(): V[] {
    return [...this.values()];
  }

  public find(predicate: (value: V, key: K) => boolean): V | undefined {
    for (const [key, value] of this) {
      if (predicate(value, key)) {
        return value;
      }
    }
    return undefined;
  }

  public filter(predicate: (value: V, key: K) => boolean): V[] {
    return this.toArray().filter((value) => predicate(value, this.keyOf(value) as K));
  }

  public map<T>(fn: (value: V, key: K) => T): T[] {
    return [...this].map(([key, value]) => fn(value, key));
  }

  private keyOf(target: V): K | undefined {
    for (const [key, value] of this) {
      if (value === target) {
        return key;
      }
    }
    return undefined;
  }
}

/** What a {@link Community} needs from its client to act on itself. */
export interface CommunityContext {
  store: CommunityStore;
  onLeave?: (communityId: string) => void;
  /** Resolves a pubkey to a profile, so members can carry user info. */
  resolveUser?: (pubkey: string) => Promise<unknown>;
}

/**
 * A community the bot is in — the rough equivalent of a discord.js `Guild`.
 *
 * Carries the keys the invite vended, so it is a credential as much as a
 * description. Do not log one wholesale.
 */
export class Community {
  private memberManager?: CommunityMemberManager;

  constructor(
    private readonly data: JoinedCommunity,
    private readonly context: CommunityContext,
  ) {}

  public get id(): string {
    return this.data.communityId;
  }

  public get name(): string {
    return this.data.name || this.data.communityId;
  }

  public get protocol(): InviteProtocol {
    return this.data.protocol;
  }

  public get epoch(): number {
    return this.data.epoch;
  }

  public get relays(): string[] {
    return [...this.data.relays];
  }

  /** Channels the invite granted, each with its key where one was vended. */
  public get channels(): InviteChannel[] {
    return this.data.channels.map((channel) => ({ ...channel }));
  }

  /** Who invited the bot, hex. Seal-verified at the time, not a claim. */
  public get invitedBy(): string {
    return this.data.invitedBy;
  }

  public get joinedAt(): Date {
    return new Date(this.data.joinedAt);
  }

  /**
   * Whether the community can see the bot.
   *
   * False until the join is announced on the guestbook, which needs the
   * Concord v2 stream layer. So a bot holds valid keys while remaining
   * invisible to the room.
   */
  public get announced(): boolean {
    return this.data.announced;
  }

  /**
   * The members this bot can see — discord.js's `guild.members`, with the
   * caveat that it is partial. Read {@link CommunityMemberManager} before
   * showing a count.
   */
  public get members(): CommunityMemberManager {
    if (!this.memberManager) {
      this.memberManager = new CommunityMemberManager(this, this.context.resolveUser);
    }
    return this.memberManager;
  }

  /** The stored record, keys included. */
  public toJSON(): JoinedCommunity {
    return { ...this.data };
  }

  /** Leave, discarding the stored keys. */
  public async leave(): Promise<boolean> {
    const removed = await this.context.store.remove(this.id);
    if (removed) {
      this.context.onLeave?.(this.id);
    }
    return removed;
  }

  public toString(): string {
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
  public readonly cache = new Collection<string, Community>();

  constructor(
    private readonly store: CommunityStore,
    private readonly onLeave?: (communityId: string) => void,
    private readonly resolveUser?: (pubkey: string) => Promise<unknown>,
  ) {}

  public get size(): number {
    return this.cache.size;
  }

  /** Read the store and refresh the cache. */
  public async fetch(): Promise<Collection<string, Community>> {
    const all = await this.store.all();
    this.cache.clear();
    for (const data of all) {
      this.cache.set(
        data.communityId,
        new Community(data, {
          store: this.store,
          onLeave: this.onLeave,
          resolveUser: this.resolveUser,
        }),
      );
    }
    return this.cache;
  }

  /** A community by id, from the cache. Call {@link fetch} first. */
  public get(communityId: string): Community | undefined {
    return this.cache.get(communityId);
  }

  /** A community by id, reading the store when it is not cached. */
  public async resolve(communityId: string): Promise<Community | undefined> {
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
  public async leave(communityId: string): Promise<boolean> {
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

// ── members ──────────────────────────────────────────────────────────────────

/** How the bot came to know about a member. */
export type MemberSource = 'owner' | 'inviter' | 'observed';

/**
 * Someone the bot knows to be in a community — the rough equivalent of a
 * discord.js `GuildMember`.
 *
 * `user` is the account's profile; `source` says why the bot believes they are
 * a member, which matters because the evidence differs in strength: the owner
 * is proven by the community id itself, an inviter by a verified seal, an
 * observed member only by having been seen.
 */
export interface CommunityMember<TUser = unknown> {
  /** Public key, hex. */
  pubkey: string;
  /** The account's profile, when one has been fetched. */
  user?: TUser;
  source: MemberSource;
  /** True for the account the community id self-certifies as owner. */
  isOwner: boolean;
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
export class CommunityMemberManager<TUser = unknown> {
  private readonly observed = new Set<string>();

  constructor(
    private readonly community: Community,
    private readonly resolveUser?: (pubkey: string) => Promise<TUser>,
  ) {}

  /**
   * Whether this list is the community's real membership.
   *
   * Always false today. Check it before showing a count.
   */
  public get complete(): boolean {
    return false;
  }

  /** The owner's pubkey, hex, when the bundle named one. */
  public get ownerId(): string | undefined {
    return this.community.toJSON().owner;
  }

  /** Record someone seen acting in this community. */
  public observe(pubkey: string): void {
    const owner = this.ownerId;
    if (pubkey && pubkey !== owner && pubkey !== this.community.invitedBy) {
      this.observed.add(pubkey);
    }
  }

  /** Every member the bot knows about, without fetching profiles. */
  public list(): CommunityMember<TUser>[] {
    const owner = this.ownerId;
    const out: CommunityMember<TUser>[] = [];
    const seen = new Set<string>();

    const push = (pubkey: string | undefined, source: MemberSource) => {
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
  public async fetch(): Promise<CommunityMember<TUser>[]> {
    const members = this.list();
    if (!this.resolveUser) {
      return members;
    }
    return Promise.all(
      members.map(async (member) => ({
        ...member,
        user: await this.resolveUser!(member.pubkey),
      })),
    );
  }

  /** How many members the bot knows about. Not the community's size. */
  public get size(): number {
    return this.list().length;
  }
}
