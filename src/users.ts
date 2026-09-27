/**
 * Users and their profiles — the rough equivalent of discord.js's `User` and
 * `client.users`.
 *
 * A Nostr profile is a kind-0 event the account publishes about itself. It is
 * self-asserted: anyone can claim any `name` or `picture`. The only field that
 * means anything on its own is the pubkey, and the only claim that can be
 * checked is `nip05`, which points at a domain that must name the key back.
 */

import type { Event, Filter } from 'nostr-tools';
import { nip19 } from 'nostr-tools';

import type { VectorClient } from './client.js';
import { normalizePublicKey } from './keys.js';
import { Collection } from './communities.js';

/** How long to wait on relays for a profile lookup. */
const FETCH_TIMEOUT_MS = 4000;

/** How long a fetched profile is trusted before it is looked up again. */
export const PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;

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
export function parseProfile(event: Event | null | undefined): ProfileFields {
  if (!event || event.kind !== 0 || !event.content) {
    return {};
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    return {};
  }

  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : undefined;

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

/** What a {@link User} needs from its client to act. */
export interface UserContext {
  client: VectorClient;
  send?: (pubkey: string, content: string) => Promise<unknown>;
}

/**
 * One account: its key, its self-asserted profile, and what you can do with it.
 */
export class User {
  constructor(
    /** Public key, hex. The only part of a user that is not a claim. */
    public readonly pubkey: string,
    private profile: ProfileFields,
    private readonly context: UserContext,
    /** When the profile was fetched; undefined means it was never found. */
    public fetchedAt?: number,
  ) {}

  /** Public key, bech32. */
  public get npub(): string {
    return nip19.npubEncode(this.pubkey);
  }

  /**
   * The best name to show: the display name, the handle, else a short npub.
   *
   * Never empty, so callers can render it without a fallback of their own.
   */
  public get displayName(): string {
    return (
      this.profile.displayName ||
      this.profile.name ||
      `${this.npub.slice(0, 12)}…`
    );
  }

  /** The handle, when the account set one. */
  public get username(): string | undefined {
    return this.profile.name;
  }

  public get about(): string | undefined {
    return this.profile.about;
  }

  /** Avatar URL. Unverified — it is whatever the account put there. */
  public get avatarURL(): string | undefined {
    return this.profile.picture;
  }

  public get bannerURL(): string | undefined {
    return this.profile.banner;
  }

  /**
   * The account's NIP-05 identifier, e.g. `alice@example.com`.
   *
   * A *claim*. Confirming it means asking that domain whether it names this
   * pubkey back — see {@link verifyNip05}.
   */
  public get nip05(): string | undefined {
    return this.profile.nip05;
  }

  /** Lightning address. */
  public get lud16(): string | undefined {
    return this.profile.lud16;
  }

  /** Whether the account flags itself as a bot. Self-asserted. */
  public get bot(): boolean {
    return this.profile.bot === true;
  }

  /** Whether a profile was ever found for this key. */
  public get known(): boolean {
    return this.fetchedAt !== undefined;
  }

  /** The raw profile fields. */
  public toJSON(): ProfileFields & { pubkey: string; npub: string } {
    return { ...this.profile, pubkey: this.pubkey, npub: this.npub };
  }

  /** Replace the cached profile, e.g. after a refetch. */
  public patch(profile: ProfileFields, fetchedAt = Date.now()): this {
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
  public async verifyNip05(): Promise<boolean> {
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
      const payload = (await response.json()) as { names?: Record<string, string> };
      return payload.names?.[name]?.toLowerCase() === this.pubkey.toLowerCase();
    } catch {
      return false;
    }
  }

  /** Send this user a direct message. */
  public async send(content: string): Promise<unknown> {
    if (!this.context.send) {
      throw new Error('This User was built without a send function');
    }
    return this.context.send(this.pubkey, content);
  }

  /** The relays this user wants gift wraps delivered to (NIP-17 kind 10050). */
  public async dmRelays(): Promise<string[]> {
    return this.context.client.inboxRelays.resolve(this.pubkey);
  }

  public toString(): string {
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
  public readonly cache = new Collection<string, User>();

  constructor(
    private readonly client: VectorClient,
    private readonly sendFn?: (pubkey: string, content: string) => Promise<unknown>,
    private readonly ttlMs: number = PROFILE_CACHE_TTL_MS,
  ) {}

  private get relays(): string[] {
    return Array.from(new Set([...this.client.relays, ...this.client.discoveryRelays]));
  }

  private context(): UserContext {
    return { client: this.client, send: this.sendFn };
  }

  /** A cached user, without touching the network. */
  public get(user: string): User | undefined {
    try {
      return this.cache.get(normalizePublicKey(user));
    } catch {
      return undefined;
    }
  }

  /**
   * Fetch a user's profile, from cache when it is fresh.
   *
   * `force` re-queries regardless of the cache.
   */
  public async fetch(user: string, options: { force?: boolean } = {}): Promise<User> {
    const pubkey = normalizePublicKey(user);

    const cached = this.cache.get(pubkey);
    if (
      cached &&
      !options.force &&
      cached.fetchedAt !== undefined &&
      Date.now() - cached.fetchedAt < this.ttlMs
    ) {
      return cached;
    }

    const filter: Filter = { kinds: [0], authors: [pubkey], limit: 1 };
    let event: Event | null = null;
    try {
      event = await Promise.race([
        this.client.pool.get(this.relays, filter),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);
        }),
      ]);
    } catch {
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
  public async fetchMany(users: string[]): Promise<Collection<string, User>> {
    const pubkeys = Array.from(
      new Set(
        users
          .map((user) => {
            try {
              return normalizePublicKey(user);
            } catch {
              return null;
            }
          })
          .filter((value): value is string => value !== null),
      ),
    );

    const out = new Collection<string, User>();
    if (!pubkeys.length) {
      return out;
    }

    let events: Event[] = [];
    try {
      events = await this.client.pool.querySync(
        this.relays,
        { kinds: [0], authors: pubkeys, limit: pubkeys.length * 2 },
        { maxWait: FETCH_TIMEOUT_MS },
      );
    } catch {
      events = [];
    }

    // Relays can hand back several profiles per author; the newest wins.
    const newest = new Map<string, Event>();
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
  public invalidate(user: string): void {
    try {
      this.cache.delete(normalizePublicKey(user));
    } catch {
      // Not a key we could have cached.
    }
  }
}
