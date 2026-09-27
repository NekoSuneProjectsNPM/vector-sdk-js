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
import type { Event } from 'nostr-tools';
import type { VectorClient } from './client.js';
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
export declare class ContactsError extends Error {
}
/** Read a kind-3 event's `p` tags into contacts, deduped by pubkey. */
export declare function parseContactList(event: Event | null | undefined): Contact[];
/** Build the `p` tags for a contact list event. */
export declare function contactTags(contacts: Contact[]): string[][];
/**
 * The bot's friend list.
 *
 * Every mutating call fetches the current published list first, so a bot that
 * restarts, or a second client that edits the same account, does not clobber
 * what it never saw.
 */
export declare class Contacts {
    private readonly client;
    constructor(client: VectorClient);
    /** Fetch the bot's current contact list event from its relays. */
    fetchEvent(): Promise<Event | null>;
    /** Everyone the bot currently follows. */
    list(): Promise<Contact[]>;
    /** Whether the bot follows `user` (npub or hex). */
    has(user: string): Promise<boolean>;
    /**
     * Follow `user`, keeping everyone already on the list.
     *
     * Returns the full list as published. Adding someone already followed
     * updates their relay hint and petname rather than duplicating them.
     */
    add(user: string, options?: {
        relay?: string;
        petname?: string;
    }): Promise<Contact[]>;
    /** Unfollow `user`, keeping everyone else. */
    remove(user: string): Promise<Contact[]>;
    /**
     * Replace the whole contact list.
     *
     * This is the destructive one — whatever is published now is the list.
     * Prefer {@link add} and {@link remove}.
     */
    publish(contacts: Contact[]): Promise<Event>;
}
