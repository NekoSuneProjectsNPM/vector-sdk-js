/**
 * Friends: the bot's NIP-02 contact list (kind 3).
 *
 * A contact list is a single replaceable event holding every pubkey the bot
 * follows. It is public — anyone can read who a bot follows — and it is
 * *replaceable*, meaning each publish overwrites the last. So the list has to
 * be fetched, amended and republished whole; publishing a list of one would
 * drop everyone else.
 *
 * Vector itself does not use kind 3 to decide who you can talk to — any npub
 * can DM any other npub. This is a public, portable address book, useful for
 * making a bot's associations discoverable to other Nostr clients, not an
 * access-control list.
 */

import type { Event, Filter } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';

import type { VectorClient } from './client.js';
import { CONTACT_LIST } from './kinds.js';
import { normalizePublicKey } from './keys.js';

/** One entry in a contact list. */
export interface Contact {
  /** Public key, hex. */
  pubkey: string;
  /** Public key, bech32. */
  npub: string;
  /** Optional relay hint from the `p` tag. */
  relay?: string;
  /** Optional petname from the `p` tag — a local nickname for this contact. */
  petname?: string;
}

export class ContactsError extends Error {}

/** How long to wait on relays when fetching an existing contact list. */
const FETCH_TIMEOUT_MS = 4000;

/** Read a kind-3 event's `p` tags into contacts, deduped by pubkey. */
export function parseContactList(event: Event | null | undefined): Contact[] {
  if (!event || event.kind !== CONTACT_LIST) {
    return [];
  }

  const out: Contact[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== 'p' || typeof tag[1] !== 'string') {
      continue;
    }
    let pubkey: string;
    try {
      pubkey = normalizePublicKey(tag[1]);
    } catch {
      continue; // a malformed entry should not sink the whole list
    }
    if (seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    out.push({
      pubkey,
      npub: nip19.npubEncode(pubkey),
      relay: tag[2] || undefined,
      petname: tag[3] || undefined,
    });
  }
  return out;
}

/** Build the `p` tags for a contact list event. */
export function contactTags(contacts: Contact[]): string[][] {
  return contacts.map((contact) => {
    // NIP-02 is positional: a petname needs a relay slot ahead of it, even an
    // empty one, or it would be read as the relay.
    if (contact.petname) {
      return ['p', contact.pubkey, contact.relay ?? '', contact.petname];
    }
    if (contact.relay) {
      return ['p', contact.pubkey, contact.relay];
    }
    return ['p', contact.pubkey];
  });
}

/**
 * The bot's friend list.
 *
 * Every mutating call fetches the current published list first, so a bot that
 * restarts, or a second client that edits the same account, does not clobber
 * what it never saw.
 */
export class Contacts {
  constructor(private readonly client: VectorClient) {}

  /** Fetch the bot's current contact list event from its relays. */
  public async fetchEvent(): Promise<Event | null> {
    const filter: Filter = {
      kinds: [CONTACT_LIST],
      authors: [this.client.publicKey],
      limit: 1,
    };

    const relays = Array.from(
      new Set([...this.client.relays, ...this.client.discoveryRelays]),
    );

    const event = await Promise.race([
      this.client.pool.get(relays, filter),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);
      }),
    ]);

    return event ?? null;
  }

  /** Everyone the bot currently follows. */
  public async list(): Promise<Contact[]> {
    return parseContactList(await this.fetchEvent());
  }

  /** Whether the bot follows `user` (npub or hex). */
  public async has(user: string): Promise<boolean> {
    const pubkey = normalizePublicKey(user);
    return (await this.list()).some((contact) => contact.pubkey === pubkey);
  }

  /**
   * Follow `user`, keeping everyone already on the list.
   *
   * Returns the full list as published. Adding someone already followed
   * updates their relay hint and petname rather than duplicating them.
   */
  public async add(
    user: string,
    options: { relay?: string; petname?: string } = {},
  ): Promise<Contact[]> {
    const pubkey = normalizePublicKey(user);
    const existing = await this.list();

    const entry: Contact = {
      pubkey,
      npub: nip19.npubEncode(pubkey),
      relay: options.relay,
      petname: options.petname,
    };

    const index = existing.findIndex((contact) => contact.pubkey === pubkey);
    const next = [...existing];
    if (index >= 0) {
      next[index] = { ...existing[index], ...entry };
    } else {
      next.push(entry);
    }

    await this.publish(next);
    return next;
  }

  /** Unfollow `user`, keeping everyone else. */
  public async remove(user: string): Promise<Contact[]> {
    const pubkey = normalizePublicKey(user);
    const existing = await this.list();
    const next = existing.filter((contact) => contact.pubkey !== pubkey);

    if (next.length === existing.length) {
      return existing; // not following them; nothing to republish
    }

    await this.publish(next);
    return next;
  }

  /**
   * Replace the whole contact list.
   *
   * This is the destructive one — whatever is published now is the list.
   * Prefer {@link add} and {@link remove}.
   */
  public async publish(contacts: Contact[]): Promise<Event> {
    const event = finalizeEvent(
      {
        kind: CONTACT_LIST,
        created_at: Math.floor(Date.now() / 1000),
        tags: contactTags(contacts),
        content: '',
      },
      this.client.privateKeyBytes,
    );

    await this.client.publishEvent(
      event,
      Array.from(new Set([...this.client.relays, ...this.client.discoveryRelays])),
    );
    return event;
  }
}
