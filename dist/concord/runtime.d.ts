/**
 * The live side of Concord v2 communities: subscribe to every joined
 * community's channels and guestbook, turn verified wraps into events, and
 * publish the bot's own messages, reactions, edits, deletes, joins and leaves.
 *
 * Mirrors how `vector-core`'s inbound bridge dispatches: a received wrap is
 * matched to a held channel by its author (the stream address, no trial
 * decrypt), then opened and bound to that exact channel and epoch.
 *
 * Not covered yet, and reported rather than hidden: the control plane fold
 * (live channel list, renames, the banlist, the owner-anchor check on join)
 * and following rekeys. Channels come from the invite; a rotation away from
 * the invite's keys needs a fresh invite until rekeys land.
 */
import type { Event, SimplePool } from 'nostr-tools';
import type { JoinedCommunity } from '../communities.js';
import type { GroupKey } from './derive.js';
import type { Rumor } from './stream.js';
/** What the runtime needs from its client. */
export interface CommunityRuntimeHost {
    publicKey: string;
    privateKey: Uint8Array;
    pool: SimplePool;
    publish(event: Event, relays: string[]): Promise<void>;
    /** Persist a changed community record (e.g. `announced`). */
    save(record: JoinedCommunity): Promise<void>;
    emit(event: string, ...args: unknown[]): void;
    log(...args: unknown[]): void;
}
/** A channel the bot can read and post in, with the keys resolved. */
export interface LiveChannel {
    communityId: string;
    id: string;
    name?: string;
    epoch: number;
    isPrivate: boolean;
    group: GroupKey;
}
/** What a send returns: the rumor id (what replies, edits, reactions reference). */
export interface CommunitySendResult {
    id: string;
    sent: boolean;
}
/** A message received in a community channel. */
export interface CommunityMessage {
    /** Rumor id: stable across relays and re-wraps. */
    id: string;
    communityId: string;
    communityName: string;
    channelId: string;
    channelName?: string;
    /** Author pubkey, hex (the seal-verified signer). */
    author: string;
    content: string;
    /** True send time in ms. */
    createdAt: number;
    /** Kind 9 (message) or 1111 (threaded comment). */
    kind: number;
    replyTo?: {
        id: string;
        author?: string;
    };
    emoji: [string, string][];
    rumor: Rumor;
    /** Reply in the same channel, quoting this message. */
    reply(content: string): Promise<CommunitySendResult>;
    /** React to this message. */
    react(emoji: string): Promise<CommunitySendResult>;
}
/**
 * Resolve an invite's channel grants to their keys (CORD-03 §1): a public
 * channel reads under the community root at the root epoch; a private one
 * under its own key at its own epoch.
 */
export declare function resolveChannels(record: JoinedCommunity): LiveChannel[];
export declare class CommunityRuntime {
    private readonly host;
    private readonly live;
    private readonly seen;
    private stopped;
    constructor(host: CommunityRuntimeHost);
    /** Start following every given community. */
    start(records: JoinedCommunity[]): Promise<void>;
    /** Every channel the bot can currently read, across communities. */
    channels(communityId?: string): LiveChannel[];
    /**
     * Follow a community. `announce` publishes the guestbook join when the bot
     * has not joined before; an existing join on the relays is adopted instead,
     * since every re-publish shows as "<bot> has joined" to the whole community.
     */
    add(record: JoinedCommunity, options?: {
        announce?: boolean;
    }): Promise<void>;
    /** Stop following a community (keys are the store's business, not ours). */
    remove(communityId: string): void;
    stop(): void;
    private subscribe;
    private markSeen;
    private handleWrap;
    private dispatchChat;
    /** Whether the bot already has a join on the community's guestbook. */
    private hasJoined;
    private announceJoin;
    /** Publish the guestbook leave. Call before discarding the community's keys. */
    announceLeave(record: JoinedCommunity): Promise<void>;
    private channel;
    private publishChat;
    /** Post a message in a channel (by id or name). */
    send(communityId: string, channelId: string, content: string, options?: {
        replyTo?: {
            id: string;
            author: string;
        };
        emoji?: [string, string][];
        expiration?: number;
    }): Promise<CommunitySendResult>;
    react(communityId: string, channelId: string, target: {
        id: string;
        author: string;
        kind?: number;
    }, emoji: string, options?: {
        emojiUrl?: string;
    }): Promise<CommunitySendResult>;
    /** Edit one of the bot's own messages. */
    edit(communityId: string, channelId: string, messageId: string, content: string): Promise<CommunitySendResult>;
    /** Delete one of the bot's own messages. */
    delete(communityId: string, channelId: string, messageId: string): Promise<CommunitySendResult>;
    /** Show a typing indicator (ephemeral; relays don't store it). */
    typing(communityId: string, channelId: string): Promise<CommunitySendResult>;
}
