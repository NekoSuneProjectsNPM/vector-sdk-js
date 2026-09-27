import { SimplePool, Event } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';
import type { Metadata } from './metadata.js';
import { metadataToContent } from './metadata.js';
import { normalizePrivateKey } from './keys.js';
import { buildInboxRelayList, InboxRelayResolver } from './inbox-relays.js';
import { DISCOVERY_RELAYS } from './bot-interface.js';

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

const DEFAULT_RELAYS = [
  'wss://jskitty.cat/nostr',
  'wss://relay.damus.io',
  'wss://auth.nostr1.com',
  'wss://nostr.computingcache.com',
];

function ensureWebSocket(): void {
  if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
  }
}

export class VectorClient {
  public readonly pool = new SimplePool();
  public readonly relays: string[];
  public readonly discoveryRelays: string[];
  public readonly publicKey: string;
  public readonly privateKey: string;
  public readonly privateKeyBytes: Uint8Array;
  public readonly legacyNip04: boolean;
  public readonly selfWrap: boolean;
  public readonly useInboxRelays: boolean;
  public readonly inboxRelays: InboxRelayResolver;
  private readonly publishRetries: number;

  constructor(keys: string, config?: ClientConfig) {
    ensureWebSocket();
    const normalized = normalizePrivateKey(keys);
    this.privateKey = normalized.hex;
    this.privateKeyBytes = normalized.bytes;
    this.publicKey = getPublicKey(this.privateKeyBytes);
    this.relays = (config?.defaultRelays ?? DEFAULT_RELAYS)
      .map((relay) => relay.trim())
      .filter(Boolean);
    this.discoveryRelays = (config?.discoveryRelays ?? [...DISCOVERY_RELAYS])
      .map((relay) => relay.trim())
      .filter(Boolean);
    this.publishRetries = Math.max(0, config?.publishRetries ?? 1);
    this.legacyNip04 = config?.legacyNip04 === true;
    this.selfWrap = config?.selfWrap !== false;
    this.useInboxRelays = config?.useInboxRelays !== false;

    // Inbox lists are replaceable events, so the discovery indexers are the
    // reliable place to find one even when a recipient's own relay is down.
    this.inboxRelays = new InboxRelayResolver(
      this.pool,
      Array.from(new Set([...this.relays, ...this.discoveryRelays])),
    );
  }

  /**
   * Fetch this account's currently published profile, if it has one.
   *
   * Kind 0 is replaceable, so this is the whole profile — there is no partial
   * update on the wire, and publishing replaces everything.
   */
  public async fetchOwnProfile(): Promise<Record<string, unknown> | null> {
    const relays = Array.from(new Set([...this.relays, ...this.discoveryRelays]));
    let event: Event | null = null;
    try {
      event = await Promise.race([
        this.pool.get(relays, { kinds: [0], authors: [this.publicKey], limit: 1 }),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 4000);
        }),
      ]);
    } catch {
      return null;
    }

    if (!event?.content) {
      return null;
    }
    try {
      return JSON.parse(event.content) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Publish this account's profile.
   *
   * Kind 0 replaces wholesale, so publishing a partial profile *erases*
   * everything left out. `merge` (the default) reads what is already published
   * and writes the new fields over it, which is what stops a bot connecting
   * with a human's key from wiping that person's name, picture and bio.
   */
  public async setMetadata(
    metadata: Metadata,
    options: { merge?: boolean } = {},
  ): Promise<void> {
    let content = metadataToContent(metadata);

    if (options.merge !== false) {
      const existing = await this.fetchOwnProfile();
      if (existing) {
        const incoming = JSON.parse(content) as Record<string, unknown>;
        content = JSON.stringify({ ...existing, ...incoming });
      }
    }

    const event: Event = finalizeEvent(
      { kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content },
      this.privateKeyBytes,
    );

    await this.publish(event, this.relays, this.publishRetries);
  }

  /**
   * Publish the account's existing profile with `bot` set explicitly.
   *
   * Vector only re-evaluates its badge when the `bot` field is present, so an
   * account wrongly flagged cannot be cleared by removing the field — the flag
   * simply persists. Writing `bot: false` is the only thing that clears it.
   *
   * Every other field is carried over untouched.
   */
  public async setBotFlag(bot: boolean): Promise<Record<string, unknown>> {
    const existing = (await this.fetchOwnProfile()) ?? {};
    const content = { ...existing, bot };

    const event: Event = finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(content),
      },
      this.privateKeyBytes,
    );

    await this.publish(
      event,
      Array.from(new Set([...this.relays, ...this.discoveryRelays])),
      this.publishRetries,
    );
    return content;
  }

  /**
   * Publish this bot's own NIP-17 inbox relay list, so other clients know where
   * to deliver its gift wraps instead of guessing.
   */
  public async publishInboxRelayList(relays?: string[]): Promise<void> {
    const event = buildInboxRelayList(relays ?? this.relays, this.privateKeyBytes);
    await this.publish(
      event,
      Array.from(new Set([...this.relays, ...this.discoveryRelays])),
      this.publishRetries,
    );
  }

  public async publishEvent(event: Event, relays?: string[]): Promise<void> {
    return this.publish(event, relays ?? this.relays, this.publishRetries);
  }

  /**
   * Publish a gift wrap to where `recipientPubkey` actually looks for it.
   *
   * The recipient's inbox relays are used when it publishes a kind 10050 and
   * {@link useInboxRelays} is on; otherwise this falls back to the bot's own
   * relays, which is also where the send lands if the lookup finds nothing.
   */
  public async publishGiftWrap(event: Event, recipientPubkey: string): Promise<void> {
    if (!this.useInboxRelays) {
      return this.publishEvent(event);
    }

    let targets = this.relays;
    try {
      targets = await this.inboxRelays.targetsFor(recipientPubkey, this.relays);
    } catch {
      // A lookup failure is never a send failure — fall back to our own relays.
    }
    return this.publish(event, targets, this.publishRetries);
  }

  private async publish(event: Event, relays: string[], retries = 0): Promise<void> {
    if (!relays.length) {
      throw new Error('At least one relay is required');
    }

    await Promise.allSettled(relays.map((relay) => this.pool.ensureRelay(relay)));
    const results = await Promise.allSettled(this.pool.publish(relays, event));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');

    if (fulfilled.length > 0) {
      return;
    }

    const firstRejected = results.find((result) => result.status === 'rejected');
    const reason =
      firstRejected && firstRejected.status === 'rejected'
        ? firstRejected.reason
        : new Error('Failed to publish to relays');
    const error = reason instanceof Error ? reason : new Error(String(reason));

    if (retries > 0) {
      await this.publish(event, relays, retries - 1);
      return;
    }

    throw error;
  }
}

export function buildClient(keys: string, config?: ClientConfig): VectorClient {
  return new VectorClient(keys, config);
}
