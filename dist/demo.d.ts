import { EventEmitter } from 'events';
import type { Event } from 'nostr-tools';
import type { AttachmentFile, ReceivedAttachment, SendOptions, SendResult } from './bot.js';
import { CommandBuilder } from './commands.js';
import { Contacts } from './contacts.js';
import type { Contact } from './contacts.js';
import type { CommunityInvite, ReceivedInvite } from './invites.js';
import { CommunityManager, CommunityStore } from './communities.js';
import type { Community, JoinedCommunity } from './communities.js';
export type BotProfile = {
    name: string;
    displayName: string;
    about: string;
    picture: string;
    banner: string;
    nip05: string;
    lud16: string;
};
export type BotClientOptions = {
    privateKey: string;
    relays: string[];
    groupIds?: string[];
    vectorOnly?: boolean;
    mlsAdapter?: MlsAdapter;
    autoDiscoverGroups?: boolean;
    discoverGroupsFromHistory?: boolean;
    historySinceHours?: number;
    historyMaxEvents?: number;
    debug?: boolean;
    profile?: Partial<BotProfile>;
    reconnect?: boolean;
    reconnectIntervalMs?: number;
    /**
     * Also send DMs as NIP-04 (kind 4). Vector ignores kind 4, so this is off by
     * default; turn it on only to reach a client that still speaks it.
     */
    legacyNip04?: boolean;
    /**
     * Gift-wrap a copy of every outgoing message to the bot itself, so the
     * account's other devices see what this one sent. On by default, matching
     * Vector.
     */
    selfWrap?: boolean;
    /**
     * Deliver gift wraps to the recipient's published NIP-17 inbox relays
     * (kind 10050) instead of only the bot's own set. On by default.
     */
    useInboxRelays?: boolean;
    /** Extra relays for manifest and inbox-list discovery. */
    discoveryRelays?: string[];
    /**
     * Where accepted communities and their keys are stored. Holds live key
     * material, so it is written owner-only and belongs out of version control.
     */
    communitiesFile?: string;
    /**
     * Publish the slash-command manifest on connect. On by default whenever at
     * least one command is registered.
     */
    publishManifest?: boolean;
};
export type MlsDecryptedMessage = {
    groupId: string;
    senderPubkey: string;
    content: string;
    kind?: number;
};
export type MlsAdapter = {
    ensureKeyPackage?: (context: {
        botPublicKey: string;
        botPrivateKey: string;
        relays: string[];
    }) => Promise<{
        published: boolean;
        eventId?: string;
    } | null>;
    syncWelcomes?: (context: {
        botPublicKey: string;
        botPrivateKey: string;
        relays: string[];
        sinceHours?: number;
        limit?: number;
    }) => Promise<{
        processed: number;
        accepted?: number;
        groups: string[];
    } | null>;
    processWelcome?: (input: {
        wrapperEvent: Event;
        rumorJson: string;
        groupIdHint?: string;
        context: {
            botPublicKey: string;
            botPrivateKey: string;
            botPrivateKeyBytes: Uint8Array;
            relays: string[];
        };
    }) => Promise<{
        groupId?: string;
    } | null>;
    decryptGroupWrapper: (wrapper: Event) => Promise<MlsDecryptedMessage | null>;
    sendGroupMessage?: (groupId: string, message: string, context: {
        botPublicKey: string;
        botPrivateKey: string;
        botPrivateKeyBytes: Uint8Array;
        relays: string[];
    }) => Promise<boolean>;
    bootstrapGroups?: (context: {
        botPublicKey: string;
        relays: string[];
        knownGroupIds: string[];
    }) => Promise<string[]>;
};
export type MessageTags = {
    pubkey: string;
    conversationId: string;
    groupId?: string;
    isGroup?: boolean;
    botInGroup?: boolean;
    directedToBot?: boolean;
    origin?: 'dm' | 'group';
    kind: number;
    rawEvent: Event;
    wrapped?: boolean;
    displayName?: string;
    /** The durable message id — the rumor id, which replies and edits reference. */
    messageId?: string;
    /** Message id this is a threaded reply to, from the `e`/`reply` tag. */
    replyTo?: string;
    /**
     * Bots this message is addressed to, as npubs, from `["bot", …]` tags.
     * Empty means broadcast.
     */
    addressedBots?: string[];
    /** Present when the message carried a file attachment. */
    attachment?: ReceivedAttachment;
};
export declare class VectorBotClient extends EventEmitter {
    private bot?;
    private giftWrapSubscription?;
    private dmSubscription?;
    private groupSubscription?;
    private readonly options;
    private readonly profileCache;
    private readonly connectionState;
    private readonly relayDownStreak;
    private readonly relayUpStreak;
    private readonly relayLastReconnectAttemptAt;
    private readonly reconnectingRelays;
    private readonly configuredGroupIds;
    private readonly joinedGroupIds;
    private readonly knownGroupIds;
    private readonly observedGroupIds;
    private readonly seenMessageIds;
    private readonly commandRegistry;
    private contactsCache?;
    /**
     * Invites the bot has received, keyed by community id so repeat invites to
     * the same community collapse to one entry instead of stacking up.
     */
    private readonly receivedInvites;
    private communityStoreCache?;
    private communityManagerCache?;
    private connectionMonitor?;
    private connectionMonitorStartedAt;
    constructor(options: BotClientOptions);
    getKnownGroupIds(): string[];
    /**
     * Register a slash command. Chain typed args, then attach the handler:
     *
     * ```ts
     * client.command('roll', 'Roll a die')
     *   .int('sides', 'How many sides')
     *   .run(async (ctx) => {
     *     const sides = ctx.int('sides') ?? 6;
     *     await ctx.reply(`you rolled a d${sides}`);
     *   });
     * ```
     *
     * The manifest publishes when the client connects, so every Vector client
     * renders a `/` picker with a field per argument. A matched invocation runs
     * its handler and is consumed — it never reaches the `message` event.
     */
    command(name: string, description: string): CommandBuilder<MessageTags>;
    /** The manifest derived from every registered command, in registration order. */
    getCommandManifest(): import("./bot-interface.js").BotManifest;
    connect(): Promise<void>;
    /**
     * Publish the command manifest over the widest useful reach: the bot's own
     * relays plus the public discovery indexers.
     *
     * The indexers matter because community relays are pool-isolated and some
     * drop events from strangers, which would otherwise leave a bot's commands
     * undiscoverable to exactly the people in the room with it.
     */
    private publishInterfaceManifest;
    sendMessage(recipient: string, message: string, options?: SendOptions): Promise<boolean>;
    /**
     * Send a DM and get the message id back — what {@link replyTo},
     * {@link editMessage}, {@link react} and {@link deleteMessage} reference.
     */
    send(recipient: string, message: string, options?: SendOptions): Promise<SendResult>;
    /** Send a threaded reply to `messageId` in a DM. */
    replyTo(recipient: string, messageId: string, message: string, options?: SendOptions): Promise<SendResult>;
    /** Edit a DM the bot sent. */
    editMessage(recipient: string, messageId: string, newContent: string): Promise<SendResult>;
    /** Delete a DM the bot sent (NIP-09). */
    deleteMessage(recipient: string, messageId: string, reason?: string): Promise<boolean>;
    /** React to a message. Pass `:shortcode:` plus `emojiUrl` for a custom emoji. */
    react(recipient: string, messageId: string, emoji: string, options?: {
        emojiUrl?: string;
    }): Promise<SendResult>;
    /** Show a typing indicator in a DM. */
    typing(recipient: string): Promise<boolean>;
    sendFile(recipient: string, filePath: string, options?: SendOptions): Promise<boolean>;
    /** Send an already-loaded attachment, returning its message id. */
    sendAttachment(recipient: string, file: AttachmentFile, options?: SendOptions): Promise<SendResult>;
    /** Download a received attachment, decrypting it when it carries a key. */
    downloadAttachment(attachment: ReceivedAttachment): Promise<Buffer>;
    /** Download a received attachment and write it to `destination`. */
    saveAttachment(attachment: ReceivedAttachment, destination: string): Promise<string>;
    /** The bot's friend list. See {@link Contacts}. */
    get contacts(): Contacts;
    /** Follow someone, keeping everyone already on the list. */
    addFriend(user: string, options?: {
        relay?: string;
        petname?: string;
    }): Promise<Contact[]>;
    /** Unfollow someone, keeping everyone else. */
    removeFriend(user: string): Promise<Contact[]>;
    /** Everyone the bot currently follows. */
    getFriends(): Promise<Contact[]>;
    /**
     * Community invites the bot has received and that have not expired.
     *
     * A bot cannot mint an invite — the bundle carries key material only a member
     * holding the community's state can produce — but it can pass on one it was
     * given. See {@link forwardInvite}.
     */
    getInvites(): ReceivedInvite[];
    /** Where accepted communities and their keys are stored. */
    get communityStore(): CommunityStore;
    /**
     * The bot's communities, discord.js-style: `client.communities.cache`,
     * `.fetch()`, `.get(id)`, `.leave(id)`.
     *
     * The cache starts empty and fills on `fetch()`, mirroring discord.js, where
     * the cache is what the client has actually seen.
     */
    get communities(): CommunityManager;
    /**
     * Accept an invite: keep the keys it vended and record the community.
     *
     * `invite` is a community id the bot holds an invite for, or a bundle you
     * already have. Re-accepting replaces the stored entry, which is how a bot
     * picks up rotated keys or newly granted channels.
     *
     * **This records membership; it does not yet make the bot a participant.**
     * Announcing the join and reading or posting in a channel ride the Concord v2
     * stream layer, which this package does not implement. So the bot holds valid
     * credentials and is ready, but the community cannot see it and it cannot
     * read the room. `announced` stays false to mark exactly that.
     */
    acceptInvite(invite: string | CommunityInvite): Promise<JoinedCommunity>;
    /** Every community the bot has accepted. */
    getCommunities(): Promise<Community[]>;
    /** Forget an accepted community and discard its keys. */
    leaveCommunity(communityId: string): Promise<boolean>;
    /**
     * Drop held invites.
     *
     * With no argument it clears every invite; with a community id, just that
     * one. Expired invites are cleared by {@link pruneInvites} instead.
     */
    clearInvites(communityId?: string): number;
    /** Drop invites whose deadline has passed. Returns how many went. */
    pruneInvites(): number;
    /** A received invite by community id, expired ones included. */
    getInvite(communityId: string): ReceivedInvite | undefined;
    /**
     * Send a community invite on to someone else.
     *
     * `invite` is either a community id the bot holds an invite for, or a bundle
     * you already have. The original NIP-40 expiry is preserved, so forwarding
     * cannot outlive what the issuer granted.
     */
    forwardInvite(recipient: string, invite: string | CommunityInvite): Promise<SendResult>;
    private requireBot;
    sendGroupMessage(groupId: string, message: string): Promise<boolean>;
    close(): void;
    private startConnectionMonitor;
    private reconnectRelay;
    private setupSubscriptions;
    private bootstrapKnownGroups;
    private handleGiftWrap;
    private normalizeRumorWrapperEvent;
    private handleDirectMessage;
    private handleGroupMessage;
    private emitMessage;
    /**
     * Run `content` as a command if it matches a registration. Returns true when
     * the message was consumed.
     *
     * A parse that matches a command *name* but fails typing or a required check
     * replies with the canonical error and still consumes — a half-valid
     * invocation shouldn't leak into chat handlers as if it were conversation.
     */
    private tryCommand;
    /** This bot's npub, once connected. */
    private npub;
    private findFirstTagValue;
    private extractGroupIdFromEvent;
    private isGroupMessageDirectedToBot;
    private isGroupContentDirectedToBot;
    private isBotInGroup;
    private isGroupTracked;
    private getProfile;
    private log;
}
