import { EventEmitter } from 'events';
import { nip19 } from 'nostr-tools';
import * as nip04 from 'nostr-tools/nip04';
import { ChatMessage, EncryptedDirectMessage, PrivateDirectMessage } from 'nostr-tools/kinds';
import { finalizeEvent } from 'nostr-tools/pure';
import { VectorBot } from './bot.js';
import { loadFile, parseAttachment } from './bot.js';
import { addressedBots, CommandArgError, manifestToEvent, parseCommandText, typedArgs, usageLine, } from './bot-interface.js';
import { argAccessors, CommandBuilder, CommandRegistry } from './commands.js';
import { APPLICATION_SPECIFIC, COMMUNITY_DIRECT_INVITE, COMMUNITY_INVITE_BUNDLE, DELETION, FILE_ATTACHMENT, MESSAGE_EDIT, REACTION, } from './kinds.js';
import { Contacts } from './contacts.js';
import { buildInviteRumor, readInviteRumor } from './invites.js';
import { unwrapGiftWrap } from './giftwrap.js';
import { CommunityManager, CommunityStore, communityFromInvite } from './communities.js';
export class VectorBotClient extends EventEmitter {
    constructor(options) {
        super();
        this.profileCache = new Map();
        this.connectionState = new Map();
        this.relayDownStreak = new Map();
        this.relayUpStreak = new Map();
        this.relayLastReconnectAttemptAt = new Map();
        this.reconnectingRelays = new Set();
        this.configuredGroupIds = new Set();
        this.joinedGroupIds = new Set();
        this.knownGroupIds = new Set();
        this.observedGroupIds = new Set();
        this.seenMessageIds = new Set();
        this.commandRegistry = new CommandRegistry();
        /**
         * Invites the bot has received, keyed by community id so repeat invites to
         * the same community collapse to one entry instead of stacking up.
         */
        this.receivedInvites = new Map();
        this.connectionMonitorStartedAt = 0;
        this.options = options;
        for (const groupId of options.groupIds ?? []) {
            const normalized = groupId.trim();
            if (normalized) {
                this.configuredGroupIds.add(normalized);
                this.joinedGroupIds.add(normalized);
                this.knownGroupIds.add(normalized);
            }
        }
    }
    getKnownGroupIds() {
        return Array.from(this.knownGroupIds);
    }
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
    command(name, description) {
        return new CommandBuilder(this.commandRegistry, name, description);
    }
    /** The manifest derived from every registered command, in registration order. */
    getCommandManifest() {
        return this.commandRegistry.manifest();
    }
    async connect() {
        if (!this.options.privateKey) {
            throw new Error('Missing private key for bot client');
        }
        if (!this.options.relays.length) {
            throw new Error('At least one relay is required');
        }
        const profile = {
            name: 'vector-bot',
            displayName: 'Vector Bot',
            about: 'Vector bot created with the SDK',
            picture: 'https://example.com/avatar.png',
            banner: 'https://example.com/banner.png',
            nip05: '',
            lud16: '',
            ...this.options.profile,
        };
        const bot = await VectorBot.new(this.options.privateKey, profile.name, profile.displayName, profile.about, profile.picture, profile.banner, profile.nip05, profile.lud16, {
            defaultRelays: this.options.relays,
            legacyNip04: this.options.legacyNip04,
            selfWrap: this.options.selfWrap,
            useInboxRelays: this.options.useInboxRelays,
            discoveryRelays: this.options.discoveryRelays,
        });
        this.bot = bot;
        this.log('Connected. Bot public key:', bot.publicKey);
        await this.publishInterfaceManifest(bot);
        if (this.options.mlsAdapter?.ensureKeyPackage) {
            try {
                const result = await this.options.mlsAdapter.ensureKeyPackage({
                    botPublicKey: bot.publicKey,
                    botPrivateKey: bot.privateKey,
                    relays: bot.client.relays,
                });
                this.emit('mls_keypackage', {
                    published: result?.published ?? false,
                    eventId: result?.eventId,
                });
            }
            catch (error) {
                this.log('MLS adapter ensureKeyPackage failed:', error);
                this.emit('error', error);
            }
        }
        await this.bootstrapKnownGroups(bot);
        this.setupSubscriptions(bot);
        this.startConnectionMonitor(bot);
        this.emit('ready', {
            pubkey: bot.publicKey,
            profile: {
                name: profile.name,
                displayName: profile.displayName,
            },
            commands: this.commandRegistry.size,
            knownGroupIds: this.getKnownGroupIds(),
        });
    }
    /**
     * Publish the command manifest over the widest useful reach: the bot's own
     * relays plus the public discovery indexers.
     *
     * The indexers matter because community relays are pool-isolated and some
     * drop events from strangers, which would otherwise leave a bot's commands
     * undiscoverable to exactly the people in the room with it.
     */
    async publishInterfaceManifest(bot) {
        if (this.commandRegistry.isEmpty() || this.options.publishManifest === false) {
            return;
        }
        try {
            const manifest = this.commandRegistry.manifest();
            const event = manifestToEvent(manifest, bot.privateKeyBytes);
            const relays = Array.from(new Set([...bot.client.relays, ...bot.client.discoveryRelays]));
            await bot.client.publishEvent(event, relays);
            this.log('Published interface manifest:', this.commandRegistry.size, 'command(s)');
            this.emit('manifest_published', {
                commands: manifest.commands?.length ?? 0,
                relays,
            });
        }
        catch (error) {
            this.log('Manifest publish failed:', error);
            this.emit('error', error);
        }
    }
    async sendMessage(recipient, message, options = {}) {
        const result = await this.send(recipient, message, options);
        return result.sent;
    }
    /**
     * Send a DM and get the message id back — what {@link replyTo},
     * {@link editMessage}, {@link react} and {@link deleteMessage} reference.
     */
    async send(recipient, message, options = {}) {
        const channel = this.requireBot().getChat(recipient);
        const result = await channel.send(message, options);
        this.log('Sent message to', recipient, 'id:', result.id, 'status:', result.sent);
        return result;
    }
    /** Send a threaded reply to `messageId` in a DM. */
    async replyTo(recipient, messageId, message, options = {}) {
        return this.send(recipient, message, { ...options, replyTo: messageId });
    }
    /** Edit a DM the bot sent. */
    async editMessage(recipient, messageId, newContent) {
        return this.requireBot().getChat(recipient).edit(messageId, newContent);
    }
    /** Delete a DM the bot sent (NIP-09). */
    async deleteMessage(recipient, messageId, reason = '') {
        return this.requireBot().getChat(recipient).delete(messageId, reason);
    }
    /** React to a message. Pass `:shortcode:` plus `emojiUrl` for a custom emoji. */
    async react(recipient, messageId, emoji, options = {}) {
        return this.requireBot().getChat(recipient).react(messageId, emoji, options);
    }
    /** Show a typing indicator in a DM. */
    async typing(recipient) {
        return this.requireBot().getChat(recipient).typing();
    }
    async sendFile(recipient, filePath, options = {}) {
        const channel = this.requireBot().getChat(recipient);
        const file = await loadFile(filePath);
        const result = await channel.sendFile(file, options);
        this.log('Sent file to', recipient, 'id:', result.id, 'status:', result.sent);
        return result.sent;
    }
    /** Send an already-loaded attachment, returning its message id. */
    async sendAttachment(recipient, file, options = {}) {
        return this.requireBot().getChat(recipient).sendFile(file, options);
    }
    /** Download a received attachment, decrypting it when it carries a key. */
    async downloadAttachment(attachment) {
        return this.requireBot().downloadAttachment(attachment);
    }
    /** Download a received attachment and write it to `destination`. */
    async saveAttachment(attachment, destination) {
        return this.requireBot().saveAttachment(attachment, destination);
    }
    // ── Friends (NIP-02 contact list) ──────────────────────────────────────────
    /** The bot's friend list. See {@link Contacts}. */
    get contacts() {
        if (!this.contactsCache) {
            this.contactsCache = new Contacts(this.requireBot().client);
        }
        return this.contactsCache;
    }
    /** Follow someone, keeping everyone already on the list. */
    async addFriend(user, options = {}) {
        const next = await this.contacts.add(user, options);
        this.log('Added friend', user, '- now following', next.length);
        this.emit('friend_added', { user, contacts: next });
        return next;
    }
    /** Unfollow someone, keeping everyone else. */
    async removeFriend(user) {
        const next = await this.contacts.remove(user);
        this.log('Removed friend', user, '- now following', next.length);
        this.emit('friend_removed', { user, contacts: next });
        return next;
    }
    /** Everyone the bot currently follows. */
    async getFriends() {
        return this.contacts.list();
    }
    // ── Invites ────────────────────────────────────────────────────────────────
    /**
     * Community invites the bot has received and that have not expired.
     *
     * A bot cannot mint an invite — the bundle carries key material only a member
     * holding the community's state can produce — but it can pass on one it was
     * given. See {@link forwardInvite}.
     */
    getInvites() {
        const now = Math.floor(Date.now() / 1000);
        return Array.from(this.receivedInvites.values()).filter((received) => !received.expiresAt || received.expiresAt > now);
    }
    /** Where accepted communities and their keys are stored. */
    get communityStore() {
        if (!this.communityStoreCache) {
            this.communityStoreCache = new CommunityStore(this.options.communitiesFile);
        }
        return this.communityStoreCache;
    }
    /**
     * The bot's communities, discord.js-style: `client.communities.cache`,
     * `.fetch()`, `.get(id)`, `.leave(id)`.
     *
     * The cache starts empty and fills on `fetch()`, mirroring discord.js, where
     * the cache is what the client has actually seen.
     */
    get communities() {
        if (!this.communityManagerCache) {
            this.communityManagerCache = new CommunityManager(this.communityStore, (id) => {
                this.log('Left community', id);
                this.emit('community_left', { communityId: id });
            });
        }
        return this.communityManagerCache;
    }
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
    async acceptInvite(invite) {
        let bundle;
        let invitedBy;
        let expiresAt;
        if (typeof invite === 'string') {
            const held = this.receivedInvites.get(invite);
            if (!held) {
                throw new Error(`No invite held for community ${invite}. Known: ${this.getInvites().map((i) => i.invite.communityId).join(', ') || 'none'}`);
            }
            bundle = held.invite;
            invitedBy = held.senderPubkey;
            expiresAt = held.expiresAt;
        }
        else {
            bundle = invite;
            invitedBy = '';
        }
        const community = communityFromInvite(bundle, { invitedBy, expiresAt });
        await this.communityStore.put(community);
        // The invite has done its job; holding it would only re-offer a community
        // already joined.
        this.receivedInvites.delete(community.communityId);
        // Keep the manager's cache honest about what was just joined.
        await this.communities.fetch();
        this.log('Accepted invite to', community.name, `[${community.communityId}]`);
        this.emit('community_joined', community);
        return community;
    }
    /** Every community the bot has accepted. */
    async getCommunities() {
        return (await this.communities.fetch()).toArray();
    }
    /** Forget an accepted community and discard its keys. */
    async leaveCommunity(communityId) {
        return this.communities.leave(communityId);
    }
    /**
     * Drop held invites.
     *
     * With no argument it clears every invite; with a community id, just that
     * one. Expired invites are cleared by {@link pruneInvites} instead.
     */
    clearInvites(communityId) {
        if (communityId) {
            return this.receivedInvites.delete(communityId) ? 1 : 0;
        }
        const count = this.receivedInvites.size;
        this.receivedInvites.clear();
        this.log('Cleared', count, 'invite(s)');
        return count;
    }
    /** Drop invites whose deadline has passed. Returns how many went. */
    pruneInvites() {
        const now = Math.floor(Date.now() / 1000);
        let dropped = 0;
        for (const [id, received] of this.receivedInvites) {
            if (received.expiresAt !== undefined && received.expiresAt <= now) {
                this.receivedInvites.delete(id);
                dropped += 1;
            }
        }
        if (dropped) {
            this.log('Pruned', dropped, 'expired invite(s)');
        }
        return dropped;
    }
    /** A received invite by community id, expired ones included. */
    getInvite(communityId) {
        return this.receivedInvites.get(communityId);
    }
    /**
     * Send a community invite on to someone else.
     *
     * `invite` is either a community id the bot holds an invite for, or a bundle
     * you already have. The original NIP-40 expiry is preserved, so forwarding
     * cannot outlive what the issuer granted.
     */
    async forwardInvite(recipient, invite) {
        const bot = this.requireBot();
        let bundle;
        let expiresAt;
        if (typeof invite === 'string') {
            const held = this.receivedInvites.get(invite);
            if (!held) {
                throw new Error(`No invite held for community ${invite}. The bot can only forward invites it has received.`);
            }
            const now = Math.floor(Date.now() / 1000);
            if (held.expiresAt && held.expiresAt <= now) {
                throw new Error(`The invite for community ${invite} has expired.`);
            }
            bundle = held.invite;
            expiresAt = held.expiresAt;
        }
        else {
            bundle = invite;
        }
        const rumor = buildInviteRumor(bundle, { expiresAt });
        const channel = bot.getChat(recipient);
        const result = await channel.sendRumor(rumor);
        this.log('Forwarded invite for', bundle.communityId, 'to', recipient);
        this.emit('invite_forwarded', {
            communityId: bundle.communityId,
            recipient,
            messageId: result.id,
        });
        return result;
    }
    requireBot() {
        if (!this.bot) {
            throw new Error('Bot is not connected');
        }
        return this.bot;
    }
    async sendGroupMessage(groupId, message) {
        if (!this.bot) {
            throw new Error('Bot is not connected');
        }
        const normalizedGroupId = groupId.trim();
        if (!normalizedGroupId) {
            throw new Error('Missing groupId');
        }
        const vectorOnly = this.options.vectorOnly !== false;
        if (vectorOnly) {
            const adapter = this.options.mlsAdapter;
            if (!adapter?.sendGroupMessage) {
                this.emit('error', new Error('Vector MLS group send requires options.mlsAdapter.sendGroupMessage'));
                return false;
            }
            const sent = await adapter.sendGroupMessage(normalizedGroupId, message, {
                botPublicKey: this.bot.publicKey,
                botPrivateKey: this.bot.privateKey,
                botPrivateKeyBytes: this.bot.privateKeyBytes,
                relays: this.bot.client.relays,
            });
            if (!sent) {
                return false;
            }
        }
        else {
            const event = finalizeEvent({
                kind: ChatMessage,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ['h', normalizedGroupId],
                    ['ms', (Date.now() % 1000).toString()],
                ],
                content: message,
            }, this.bot.privateKeyBytes);
            await this.bot.client.publishEvent(event);
        }
        this.joinedGroupIds.add(normalizedGroupId);
        this.knownGroupIds.add(normalizedGroupId);
        this.log('Sent group message to', normalizedGroupId);
        return true;
    }
    close() {
        if (!this.bot) {
            return;
        }
        if (this.connectionMonitor) {
            clearInterval(this.connectionMonitor);
            this.connectionMonitor = undefined;
        }
        this.giftWrapSubscription?.close('shutdown');
        this.dmSubscription?.close('shutdown');
        this.groupSubscription?.close('shutdown');
        this.bot.client.pool.close(this.bot.client.relays);
    }
    startConnectionMonitor(bot) {
        if (this.connectionMonitor) {
            clearInterval(this.connectionMonitor);
        }
        const shouldReconnect = this.options.reconnect !== false;
        const interval = this.options.reconnectIntervalMs ?? 15000;
        const disconnectThreshold = 2;
        const reconnectThreshold = 2;
        const reconnectBackoffMs = Math.max(15000, interval * 2);
        const warmupMs = Math.max(20000, interval * 2);
        this.connectionMonitorStartedAt = Date.now();
        this.connectionMonitor = setInterval(() => {
            const status = bot.client.pool.listConnectionStatus();
            for (const relay of bot.client.relays) {
                const connected = status.get(relay) ?? false;
                const previousStable = this.connectionState.get(relay);
                const downStreak = (this.relayDownStreak.get(relay) ?? 0) + (connected ? 0 : 1);
                const upStreak = (this.relayUpStreak.get(relay) ?? 0) + (connected ? 1 : 0);
                this.relayDownStreak.set(relay, connected ? 0 : downStreak);
                this.relayUpStreak.set(relay, connected ? upStreak : 0);
                if (previousStable === undefined) {
                    this.connectionState.set(relay, connected);
                }
                else if (previousStable && !connected && downStreak >= disconnectThreshold) {
                    if (Date.now() - this.connectionMonitorStartedAt >= warmupMs) {
                        this.connectionState.set(relay, false);
                        this.emit('disconnect', { relay, error: new Error('Relay disconnected') });
                    }
                }
                else if (previousStable === false && connected && upStreak >= reconnectThreshold) {
                    this.connectionState.set(relay, true);
                    this.emit('reconnect', { relay });
                }
                if (shouldReconnect && !connected) {
                    const lastAttempt = this.relayLastReconnectAttemptAt.get(relay) ?? 0;
                    if (Date.now() - lastAttempt < reconnectBackoffMs) {
                        continue;
                    }
                    this.relayLastReconnectAttemptAt.set(relay, Date.now());
                    this.reconnectRelay(bot, relay);
                }
            }
        }, interval);
    }
    async reconnectRelay(bot, relay) {
        if (this.reconnectingRelays.has(relay)) {
            return;
        }
        this.reconnectingRelays.add(relay);
        try {
            await bot.client.pool.ensureRelay(relay);
        }
        catch (error) {
            this.emit('error', error);
        }
        finally {
            this.reconnectingRelays.delete(relay);
        }
    }
    setupSubscriptions(bot) {
        const giftWrapFilter = {
            kinds: [GIFT_WRAP_KIND],
            limit: 0,
        };
        this.giftWrapSubscription = bot.client.pool.subscribe(bot.client.relays, giftWrapFilter, {
            onevent: (event) => this.handleGiftWrap(bot, event),
            onclose: (reasons) => {
                this.log('Gift-wrap subscription closed:', reasons);
                this.emit('disconnect', { relay: 'gift-wrap', error: new Error(reasons.join(', ')) });
            },
        });
        const dmFilter = {
            kinds: [EncryptedDirectMessage, PrivateDirectMessage],
            '#p': [bot.publicKey],
            limit: 0,
        };
        this.dmSubscription = bot.client.pool.subscribe(bot.client.relays, dmFilter, {
            onevent: (event) => this.handleDirectMessage(bot, event),
            onclose: (reasons) => {
                this.log('DM subscription closed:', reasons);
                this.emit('disconnect', { relay: 'dm', error: new Error(reasons.join(', ')) });
            },
        });
        const autoDiscoverGroups = this.options.autoDiscoverGroups === true;
        const groupIds = this.getKnownGroupIds();
        if (!autoDiscoverGroups && !groupIds.length) {
            this.groupSubscription = undefined;
            return;
        }
        const vectorOnly = this.options.vectorOnly !== false;
        const groupKind = vectorOnly ? VECTOR_MLS_GROUP_WRAPPER_KIND : ChatMessage;
        const groupFilter = {
            kinds: [groupKind],
            ...(autoDiscoverGroups ? {} : { '#h': groupIds }),
            limit: 0,
        };
        this.groupSubscription = bot.client.pool.subscribe(bot.client.relays, groupFilter, {
            onevent: (event) => this.handleGroupMessage(bot, event),
            onclose: (reasons) => {
                this.log('Group subscription closed:', reasons);
                this.emit('disconnect', { relay: 'group', error: new Error(reasons.join(', ')) });
            },
        });
    }
    async bootstrapKnownGroups(bot) {
        if (!this.options.discoverGroupsFromHistory) {
            return;
        }
        const now = Math.floor(Date.now() / 1000);
        const sinceHours = Math.max(1, this.options.historySinceHours ?? 24 * 30);
        const limit = Math.max(10, this.options.historyMaxEvents ?? 500);
        const vectorOnly = this.options.vectorOnly !== false;
        const groupKind = vectorOnly ? VECTOR_MLS_GROUP_WRAPPER_KIND : ChatMessage;
        try {
            await Promise.allSettled(bot.client.relays.map((relay) => bot.client.pool.ensureRelay(relay)));
            const giftWrapFilter = {
                kinds: [GIFT_WRAP_KIND],
                since: now - sinceHours * 3600,
                limit,
            };
            let giftWrapEvents = await bot.client.pool.querySync(bot.client.relays, giftWrapFilter, { maxWait: 4000 });
            if (!giftWrapEvents.length) {
                giftWrapEvents = await bot.client.pool.querySync(bot.client.relays, { kinds: [GIFT_WRAP_KIND], limit }, { maxWait: 5000 });
            }
            for (const event of giftWrapEvents) {
                this.handleGiftWrap(bot, event, false);
            }
            if (this.options.mlsAdapter?.syncWelcomes) {
                try {
                    const synced = await this.options.mlsAdapter.syncWelcomes({
                        botPublicKey: bot.publicKey,
                        botPrivateKey: bot.privateKey,
                        relays: bot.client.relays,
                        sinceHours,
                        limit,
                    });
                    this.emit('mls_welcome_sync', {
                        processed: synced?.processed ?? 0,
                        accepted: synced?.accepted ?? 0,
                        groups: synced?.groups ?? [],
                    });
                    if (synced?.groups?.length) {
                        for (const groupId of synced.groups) {
                            const normalized = groupId.trim();
                            if (!normalized) {
                                continue;
                            }
                            if (!this.knownGroupIds.has(normalized)) {
                                this.knownGroupIds.add(normalized);
                                this.joinedGroupIds.add(normalized);
                                this.emit('group_discovered', {
                                    groupId: normalized,
                                    eventId: 'adapter-sync-welcomes',
                                    sender: bot.publicKey,
                                    source: 'adapter',
                                });
                            }
                        }
                    }
                    if ((synced?.processed ?? 0) > 0 || (synced?.accepted ?? 0) > 0 || (synced?.groups?.length ?? 0) > 0) {
                        this.emit('mls_welcome_processed', { groupId: synced?.groups?.join(',') || undefined });
                    }
                }
                catch (error) {
                    this.log('MLS adapter syncWelcomes failed:', error);
                    this.emit('mls_welcome_process_failed', { error: String(error) });
                    this.emit('error', error);
                }
            }
            if (this.options.mlsAdapter?.bootstrapGroups) {
                try {
                    const groups = await this.options.mlsAdapter.bootstrapGroups({
                        botPublicKey: bot.publicKey,
                        relays: bot.client.relays,
                        knownGroupIds: this.getKnownGroupIds(),
                    });
                    for (const groupId of groups) {
                        const normalized = groupId.trim();
                        if (!normalized) {
                            continue;
                        }
                        if (!this.knownGroupIds.has(normalized)) {
                            this.knownGroupIds.add(normalized);
                            this.joinedGroupIds.add(normalized);
                            this.emit('group_discovered', {
                                groupId: normalized,
                                eventId: 'adapter-bootstrap',
                                sender: bot.publicKey,
                                source: 'adapter',
                            });
                        }
                    }
                }
                catch (error) {
                    this.log('MLS adapter bootstrap failed:', error);
                    this.emit('error', error);
                }
            }
            const wrapperFilter = {
                kinds: [groupKind],
                since: now - sinceHours * 3600,
                limit,
            };
            let events = await bot.client.pool.querySync(bot.client.relays, wrapperFilter, { maxWait: 4000 });
            if (!events.length) {
                events = await bot.client.pool.querySync(bot.client.relays, { kinds: [groupKind], limit }, { maxWait: 5000 });
            }
            let discovered = 0;
            for (const event of events) {
                const groupId = this.extractGroupIdFromEvent(event);
                if (!groupId) {
                    continue;
                }
                this.observedGroupIds.add(groupId);
                if (vectorOnly && !this.isGroupTracked(groupId)) {
                    continue;
                }
                if (!this.knownGroupIds.has(groupId)) {
                    this.knownGroupIds.add(groupId);
                    discovered += 1;
                    this.emit('group_discovered', {
                        groupId,
                        eventId: event.id,
                        sender: event.pubkey,
                        source: 'history',
                    });
                }
            }
            this.log('Group history bootstrap complete. discovered:', discovered, 'known:', this.knownGroupIds.size);
            this.emit('group_bootstrap_debug', {
                relays: bot.client.relays,
                giftWrapEvents: giftWrapEvents.length,
                groupWrapperEvents: events.length,
                sinceHours,
                limit,
            });
            this.emit('group_bootstrap_complete', {
                discovered,
                knownGroupIds: this.getKnownGroupIds(),
            });
        }
        catch (error) {
            this.log('Group history bootstrap failed:', error);
            this.emit('error', error);
        }
    }
    handleGiftWrap(bot, event, emitDirectMessages = true) {
        try {
            // Authenticates the seal: `nip59.unwrapEvent` would let a sender claim
            // any pubkey, and everything below trusts `rumor.pubkey`.
            const rumor = unwrapGiftWrap(event, bot.privateKeyBytes);
            this.log('Gift-wrap rumor:', rumor);
            if (emitDirectMessages && rumor.kind === PrivateDirectMessage && rumor.content) {
                this.emitMessage(bot, rumor.pubkey, rumor.kind, event, rumor.content, true, { rumor });
                return;
            }
            // A file attachment is an ordinary message that happens to carry a file:
            // it surfaces on `message` like any other, with the parsed attachment on
            // its tags, so a handler that ignores files needs no extra branch.
            if (emitDirectMessages && rumor.kind === FILE_ATTACHMENT) {
                const attachment = parseAttachment(rumor);
                if (attachment) {
                    this.emit('attachment', {
                        sender: rumor.pubkey,
                        messageId: rumor.id,
                        attachment,
                        rawEvent: event,
                    });
                    this.emitMessage(bot, rumor.pubkey, rumor.kind, event, rumor.content, true, {
                        rumor,
                        attachment,
                    });
                }
                return;
            }
            // A community invite. Held rather than acted on: joining a Concord v2
            // community needs the envelope and epoch-key machinery that lives in
            // vector-core, so what a bot can do here is surface it and pass it on.
            if (emitDirectMessages &&
                (rumor.kind === COMMUNITY_INVITE_BUNDLE || rumor.kind === COMMUNITY_DIRECT_INVITE)) {
                const received = readInviteRumor(rumor);
                if (received) {
                    // Relays replay history, and an inviter may click Invite repeatedly,
                    // so the same community arrives many times. Keep one entry, and let
                    // the longest-lived invite win — an older wrap may still be the one
                    // with life left in it.
                    const held = this.receivedInvites.get(received.invite.communityId);
                    const supersedes = !held ||
                        (received.expiresAt ?? Infinity) >= (held.expiresAt ?? Infinity);
                    if (!supersedes) {
                        return;
                    }
                    this.receivedInvites.set(received.invite.communityId, received);
                    this.log('Invite received for', received.invite.communityId, received.expired ? '(already expired)' : '');
                    this.emit('invite', received);
                }
                return;
            }
            if (emitDirectMessages && rumor.kind === MESSAGE_EDIT) {
                this.emit('message_update', {
                    sender: rumor.pubkey,
                    messageId: this.findFirstTagValue(rumor, 'e'),
                    editId: rumor.id,
                    content: rumor.content,
                    rawEvent: event,
                });
                return;
            }
            if (emitDirectMessages && rumor.kind === REACTION) {
                this.emit('reaction', {
                    sender: rumor.pubkey,
                    messageId: this.findFirstTagValue(rumor, 'e'),
                    emoji: rumor.content,
                    emojiUrl: rumor.tags.find((tag) => tag[0] === 'emoji')?.[2],
                    rawEvent: event,
                });
                return;
            }
            if (emitDirectMessages && rumor.kind === DELETION) {
                this.emit('message_delete', {
                    sender: rumor.pubkey,
                    messageId: this.findFirstTagValue(rumor, 'e'),
                    reason: rumor.content,
                    rawEvent: event,
                });
                return;
            }
            if (emitDirectMessages && rumor.kind === APPLICATION_SPECIFIC && rumor.content === 'typing') {
                this.emit('typing', { sender: rumor.pubkey, rawEvent: event });
                return;
            }
            if (rumor.kind === VECTOR_MLS_GROUP_WRAPPER_KIND) {
                const normalizedWrapper = this.normalizeRumorWrapperEvent(rumor, event);
                this.handleGroupMessage(bot, normalizedWrapper);
                return;
            }
            if (rumor.kind === VECTOR_MLS_WELCOME_KIND) {
                const groupIdHint = this.findFirstTagValue(rumor, 'h');
                const discoveredGroupId = groupIdHint;
                if (discoveredGroupId) {
                    this.knownGroupIds.add(discoveredGroupId);
                    this.joinedGroupIds.add(discoveredGroupId);
                    this.emit('group_discovered', {
                        groupId: discoveredGroupId,
                        eventId: event.id,
                        sender: rumor.pubkey,
                        source: 'welcome',
                    });
                }
                if (this.options.mlsAdapter?.processWelcome) {
                    const rumorJson = JSON.stringify(rumor);
                    this.options.mlsAdapter.processWelcome({
                        wrapperEvent: event,
                        rumorJson,
                        groupIdHint,
                        context: {
                            botPublicKey: bot.publicKey,
                            botPrivateKey: bot.privateKey,
                            botPrivateKeyBytes: bot.privateKeyBytes,
                            relays: bot.client.relays,
                        },
                    }).then((result) => {
                        this.emit('mls_welcome_processed', { groupId: result?.groupId });
                        const groupId = result?.groupId?.trim();
                        if (!groupId) {
                            return;
                        }
                        if (!this.knownGroupIds.has(groupId)) {
                            this.knownGroupIds.add(groupId);
                            this.joinedGroupIds.add(groupId);
                            this.emit('group_discovered', {
                                groupId,
                                eventId: event.id,
                                sender: rumor.pubkey,
                                source: 'welcome-adapter',
                            });
                        }
                    }).catch((error) => {
                        this.log('MLS adapter processWelcome failed:', error);
                        this.emit('mls_welcome_process_failed', { error: String(error) });
                        this.emit('error', error);
                    });
                }
                this.emit('mls_welcome', { rawEvent: event, rumor });
            }
        }
        catch (error) {
            // With broad GiftWrap subscription, unwrap failures are expected for events not addressed to us.
            this.log('Ignored non-decryptable gift-wrap event');
        }
    }
    normalizeRumorWrapperEvent(rumor, outerEvent) {
        const rumorId = typeof rumor.id === 'string' && /^[a-f0-9]{64}$/i.test(rumor.id)
            ? rumor.id
            : outerEvent.id;
        const rumorSig = typeof rumor.sig === 'string' && rumor.sig.length > 0
            ? rumor.sig
            : outerEvent.sig;
        const rumorCreatedAt = typeof rumor.created_at === 'number'
            ? rumor.created_at
            : outerEvent.created_at;
        return {
            id: rumorId,
            pubkey: rumor.pubkey || outerEvent.pubkey,
            created_at: rumorCreatedAt,
            kind: rumor.kind,
            tags: Array.isArray(rumor.tags) ? rumor.tags : outerEvent.tags,
            content: typeof rumor.content === 'string' ? rumor.content : outerEvent.content,
            sig: rumorSig,
        };
    }
    handleDirectMessage(bot, event) {
        if (event.kind !== EncryptedDirectMessage) {
            this.log('Unhandled DM event:', event);
            return;
        }
        try {
            const message = nip04.decrypt(bot.privateKey, event.pubkey, event.content);
            this.emitMessage(bot, event.pubkey, event.kind, event, message, false);
        }
        catch (error) {
            this.log('Failed to decrypt NIP-04 DM:', error);
            this.emit('error', error);
        }
    }
    handleGroupMessage(bot, event) {
        const vectorOnly = this.options.vectorOnly !== false;
        const expectedKind = vectorOnly ? VECTOR_MLS_GROUP_WRAPPER_KIND : ChatMessage;
        if (event.kind !== expectedKind) {
            this.log('Unhandled group event:', event);
            return;
        }
        const groupId = this.extractGroupIdFromEvent(event);
        if (!groupId) {
            this.log('Skipping group event without h tag:', event.id);
            this.emit('group_wrapper_unresolved', {
                eventId: event.id,
                sender: event.pubkey,
                tagKeys: event.tags.map((tag) => tag[0]),
            });
            return;
        }
        this.observedGroupIds.add(groupId);
        if (vectorOnly) {
            // Vector uses broad Kind:444 streams. Ignore wrappers for groups we are not in.
            if (!this.isGroupTracked(groupId)) {
                return;
            }
            if (!this.knownGroupIds.has(groupId)) {
                this.knownGroupIds.add(groupId);
                this.log('Discovered group:', groupId);
                this.emit('group_discovered', { groupId, eventId: event.id, sender: event.pubkey, source: 'live' });
            }
            this.emit('group_wrapper', { groupId, rawEvent: event });
            if (this.options.mlsAdapter?.decryptGroupWrapper) {
                this.options.mlsAdapter.decryptGroupWrapper(event)
                    .then((decrypted) => {
                    if (!decrypted?.content) {
                        this.emit('mls_wrapper_decrypt_miss', { groupId, eventId: event.id });
                        return;
                    }
                    this.emit('mls_wrapper_decrypt_hit', {
                        groupId: decrypted.groupId || groupId,
                        eventId: event.id,
                        sender: decrypted.senderPubkey || event.pubkey,
                    });
                    const resolvedGroupId = decrypted.groupId || groupId;
                    this.knownGroupIds.add(resolvedGroupId);
                    this.joinedGroupIds.add(resolvedGroupId);
                    const botInGroup = true;
                    const directedToBot = this.isGroupContentDirectedToBot(bot, decrypted.content, true, event.tags);
                    this.emitMessage(bot, decrypted.senderPubkey || event.pubkey, decrypted.kind ?? ChatMessage, event, decrypted.content, false, {
                        conversationId: resolvedGroupId,
                        groupId: resolvedGroupId,
                        isGroup: true,
                        botInGroup,
                        directedToBot,
                    }).catch((error) => {
                        this.log('Failed to emit decrypted MLS group message:', error);
                        this.emit('error', error);
                    });
                })
                    .catch((error) => {
                    this.log('MLS adapter decrypt failed:', error);
                    this.emit('mls_wrapper_decrypt_failed', { groupId, eventId: event.id, error: String(error) });
                    this.emit('error', error);
                });
            }
            return;
        }
        const botInGroup = this.isBotInGroup(bot, groupId, event);
        const directedToBot = this.isGroupMessageDirectedToBot(bot, event, botInGroup);
        this.emitMessage(bot, event.pubkey, event.kind, event, event.content, false, {
            conversationId: groupId,
            groupId,
            isGroup: true,
            botInGroup,
            directedToBot,
        }).catch((error) => {
            this.log('Failed to emit group message:', error);
            this.emit('error', error);
        });
    }
    async emitMessage(bot, pubkey, kind, rawEvent, content, wrapped, override) {
        if (this.seenMessageIds.has(rawEvent.id)) {
            return;
        }
        this.seenMessageIds.add(rawEvent.id);
        if (this.seenMessageIds.size > 10000) {
            const oldest = this.seenMessageIds.values().next().value;
            if (oldest) {
                this.seenMessageIds.delete(oldest);
            }
        }
        const profile = await this.getProfile(bot, pubkey);
        const conversationId = override?.conversationId ?? pubkey;
        const self = pubkey === bot.publicKey;
        const rumorTags = override?.rumor?.tags ?? rawEvent.tags;
        const replyTag = rumorTags.find((tag) => tag[0] === 'e');
        const tags = {
            pubkey,
            conversationId,
            groupId: override?.groupId,
            isGroup: override?.isGroup ?? false,
            botInGroup: override?.isGroup ? override?.botInGroup ?? false : false,
            directedToBot: override?.isGroup ? override?.directedToBot ?? false : true,
            origin: override?.isGroup ? 'group' : 'dm',
            kind,
            rawEvent,
            wrapped,
            displayName: profile?.displayName || profile?.name,
            messageId: override?.rumor?.id ?? rawEvent.id,
            replyTo: replyTag?.[1],
            addressedBots: addressedBots(rumorTags),
            attachment: override?.attachment,
        };
        // A registered command consumes the message: it runs its handler and never
        // reaches `message`, so command routing and free-form chat can live side by
        // side without a handler having to re-parse the text.
        if (!self && this.tryCommand(pubkey, tags, content)) {
            return;
        }
        this.emit('message', pubkey, tags, content, self);
    }
    /**
     * Run `content` as a command if it matches a registration. Returns true when
     * the message was consumed.
     *
     * A parse that matches a command *name* but fails typing or a required check
     * replies with the canonical error and still consumes — a half-valid
     * invocation shouldn't leak into chat handlers as if it were conversation.
     */
    tryCommand(senderPubkey, tags, content) {
        if (this.commandRegistry.isEmpty() || !this.bot) {
            return false;
        }
        // Addressed to some other bot: ordinary chat for us, even on a manifest
        // match, since two bots may share a command name. Untagged is broadcast —
        // the legacy-client path — so the tag is never required.
        const addressed = tags.addressedBots ?? [];
        if (addressed.length) {
            const myNpub = this.npub();
            if (myNpub && !addressed.includes(myNpub)) {
                return false;
            }
        }
        const text = content.trim();
        if (!text.startsWith('/')) {
            return false;
        }
        const manifest = this.commandRegistry.manifest();
        const parsed = parseCommandText(manifest, text);
        if (!parsed) {
            return false; // unknown command → ordinary chat, possibly for another bot
        }
        const registration = this.commandRegistry.find(parsed.name);
        if (!registration) {
            return false;
        }
        // Answering the invoker privately is always possible, including from a
        // group: a DM is addressed to their pubkey, which a group invocation
        // carries just the same.
        const replyPrivately = async (replyText) => {
            const result = await this.send(senderPubkey, replyText, {
                // A group message id belongs to the group's transport, not the DM
                // thread, so threading the DM to it would dangle.
                replyTo: tags.isGroup ? undefined : tags.messageId,
            });
            return result.sent;
        };
        const reply = async (replyText) => {
            if (tags.isGroup && tags.groupId) {
                return this.sendGroupMessage(tags.groupId, replyText);
            }
            return replyPrivately(replyText);
        };
        const dm = async (user, replyText) => {
            const result = await this.send(user, replyText);
            return result.sent;
        };
        let args;
        try {
            args = typedArgs(registration.spec, parsed);
        }
        catch (error) {
            const detail = error instanceof CommandArgError ? error.message : String(error);
            this.log('Command rejected:', parsed.name, detail);
            // The canonical two-line error: `{arg}: {reason}`, then `usage: {line}`.
            // ASCII-only and split-on-first-newline parsable, so every implementation
            // emits byte-identical text.
            reply(`${detail}\nusage: ${usageLine(registration.spec)}`).catch((replyError) => {
                this.emit('error', replyError);
            });
            return true;
        }
        const accessors = argAccessors(args);
        const context = {
            name: parsed.name,
            message: tags,
            senderPubkey,
            isGroup: tags.isGroup ?? false,
            groupId: tags.groupId,
            raw: parsed.args,
            ...accessors,
            reply,
            replyPrivately,
            dm,
        };
        this.log('Command:', parsed.name, parsed.args);
        this.emit('command', { name: parsed.name, senderPubkey, args: parsed.args });
        Promise.resolve(registration.handler(context)).catch((error) => {
            this.log('Command handler failed:', parsed.name, error);
            this.emit('error', error);
        });
        return true;
    }
    /** This bot's npub, once connected. */
    npub() {
        if (!this.bot) {
            return undefined;
        }
        try {
            return nip19.npubEncode(this.bot.publicKey);
        }
        catch {
            return undefined;
        }
    }
    findFirstTagValue(eventLike, tagName) {
        for (const tag of eventLike.tags) {
            if (tag[0] === tagName && typeof tag[1] === 'string') {
                return tag[1];
            }
        }
        return undefined;
    }
    extractGroupIdFromEvent(event) {
        const fromH = this.findFirstTagValue(event, 'h') ?? this.findFirstTagValue(event, 'H');
        if (fromH) {
            return fromH;
        }
        const fromD = this.findFirstTagValue(event, 'd');
        if (fromD && /^[a-f0-9]{32,64}$/i.test(fromD)) {
            return fromD;
        }
        for (const tag of event.tags) {
            const value = tag[1];
            if (typeof value === 'string' && /^[a-f0-9]{32,64}$/i.test(value)) {
                return value;
            }
        }
        return undefined;
    }
    isGroupMessageDirectedToBot(bot, event, botInGroup) {
        return this.isGroupContentDirectedToBot(bot, event.content ?? '', botInGroup, event.tags);
    }
    isGroupContentDirectedToBot(bot, content, botInGroup, tags) {
        // Direct mention via p-tag to bot pubkey
        for (const tag of tags) {
            if (tag[0] === 'p' && tag[1] === bot.publicKey) {
                return true;
            }
        }
        const text = (content ?? '').trim();
        if (!text) {
            return false;
        }
        const lower = text.toLowerCase();
        const botName = (bot.name ?? '').toLowerCase();
        const botDisplay = (bot.displayName ?? '').toLowerCase();
        if (botName && (lower.startsWith(`@${botName}`) || lower.startsWith(`${botName}:`))) {
            return true;
        }
        if (botDisplay && (lower.startsWith(`@${botDisplay}`) || lower.startsWith(`${botDisplay}:`))) {
            return true;
        }
        // Allow plain command invocation in groups only when bot is already known in that group.
        if (botInGroup && /^\!\S+/.test(text)) {
            return true;
        }
        return false;
    }
    isBotInGroup(bot, groupId, event) {
        if (event.pubkey === bot.publicKey) {
            this.joinedGroupIds.add(groupId);
            return true;
        }
        if (this.joinedGroupIds.has(groupId)) {
            return true;
        }
        if (this.configuredGroupIds.has(groupId)) {
            return true;
        }
        return false;
    }
    isGroupTracked(groupId) {
        if (this.joinedGroupIds.has(groupId)) {
            return true;
        }
        if (this.configuredGroupIds.has(groupId)) {
            return true;
        }
        if (this.knownGroupIds.has(groupId)) {
            return true;
        }
        return false;
    }
    async getProfile(bot, pubkey) {
        if (this.profileCache.has(pubkey)) {
            return this.profileCache.get(pubkey);
        }
        try {
            const event = await bot.client.pool.get(bot.client.relays, { kinds: [0], authors: [pubkey], limit: 1 });
            if (event && event.content) {
                const metadata = JSON.parse(event.content);
                const profile = {
                    name: metadata.name,
                    displayName: metadata.displayName,
                };
                this.profileCache.set(pubkey, profile);
                return profile;
            }
        }
        catch (error) {
            this.log('Failed to load profile for', pubkey, error);
            this.emit('error', error);
        }
        this.profileCache.set(pubkey, {});
        return undefined;
    }
    log(...args) {
        if (!this.options.debug) {
            return;
        }
        console.log('[vector-bot]', ...args);
    }
}
const VECTOR_MLS_GROUP_WRAPPER_KIND = 444;
const VECTOR_MLS_WELCOME_KIND = 443;
const GIFT_WRAP_KIND = 1059;
