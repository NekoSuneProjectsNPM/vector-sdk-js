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
import { nip19 } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { CONTACT_LIST } from './kinds.js';
import { normalizePublicKey } from './keys.js';
export class ContactsError extends Error {
}
/** How long to wait on relays when fetching an existing contact list. */
const FETCH_TIMEOUT_MS = 4000;
/** Read a kind-3 event's `p` tags into contacts, deduped by pubkey. */
export function parseContactList(event) {
    if (!event || event.kind !== CONTACT_LIST) {
        return [];
    }
    const out = [];
    const seen = new Set();
    for (const tag of event.tags) {
        if (tag[0] !== 'p' || typeof tag[1] !== 'string') {
            continue;
        }
        let pubkey;
        try {
            pubkey = normalizePublicKey(tag[1]);
        }
        catch {
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
export function contactTags(contacts) {
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
    constructor(client) {
        this.client = client;
    }
    /** Fetch the bot's current contact list event from its relays. */
    async fetchEvent() {
        const filter = {
            kinds: [CONTACT_LIST],
            authors: [this.client.publicKey],
            limit: 1,
        };
        const relays = Array.from(new Set([...this.client.relays, ...this.client.discoveryRelays]));
        const event = await Promise.race([
            this.client.pool.get(relays, filter),
            new Promise((resolve) => {
                setTimeout(() => resolve(null), FETCH_TIMEOUT_MS);
            }),
        ]);
        return event ?? null;
    }
    /** Everyone the bot currently follows. */
    async list() {
        return parseContactList(await this.fetchEvent());
    }
    /** Whether the bot follows `user` (npub or hex). */
    async has(user) {
        const pubkey = normalizePublicKey(user);
        return (await this.list()).some((contact) => contact.pubkey === pubkey);
    }
    /**
     * Follow `user`, keeping everyone already on the list.
     *
     * Returns the full list as published. Adding someone already followed
     * updates their relay hint and petname rather than duplicating them.
     */
    async add(user, options = {}) {
        const pubkey = normalizePublicKey(user);
        const existing = await this.list();
        const entry = {
            pubkey,
            npub: nip19.npubEncode(pubkey),
            relay: options.relay,
            petname: options.petname,
        };
        const index = existing.findIndex((contact) => contact.pubkey === pubkey);
        const next = [...existing];
        if (index >= 0) {
            next[index] = { ...existing[index], ...entry };
        }
        else {
            next.push(entry);
        }
        await this.publish(next);
        return next;
    }
    /** Unfollow `user`, keeping everyone else. */
    async remove(user) {
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
    async publish(contacts) {
        const event = finalizeEvent({
            kind: CONTACT_LIST,
            created_at: Math.floor(Date.now() / 1000),
            tags: contactTags(contacts),
            content: '',
        }, this.client.privateKeyBytes);
        await this.client.publishEvent(event, Array.from(new Set([...this.client.relays, ...this.client.discoveryRelays])));
        return event;
    }
}
