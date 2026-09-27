import { buildDeleteRumor, buildEditRumor, buildMessageRumor, buildReactionRumor, buildTypingRumor, ChatKind, openChatEvent, sealChatRumor, } from './chat.js';
import { bytes32, channelGroupKey, guestbookGroupKey, verifyCommunityId } from './derive.js';
import { buildJoinRumor, buildLeaveRumor, openGuestbookEvent, sealGuestbookRumor } from './guestbook.js';
import { KIND_WRAP, KIND_WRAP_EPHEMERAL } from './stream.js';
const SEEN_LIMIT = 5000;
const RESUBSCRIBE_MS = 10000;
/**
 * Resolve an invite's channel grants to their keys (CORD-03 §1): a public
 * channel reads under the community root at the root epoch; a private one
 * under its own key at its own epoch.
 */
export function resolveChannels(record) {
    const root = bytes32(record.accessKey, 'community access key');
    const out = [];
    for (const channel of record.channels) {
        const isPrivate = Boolean(channel.isPrivate);
        if (isPrivate && !channel.key) {
            continue; // listed but not granted
        }
        const secret = isPrivate ? bytes32(channel.key, 'channel key') : root;
        const epoch = isPrivate ? channel.epoch ?? 0 : record.epoch;
        out.push({
            communityId: record.communityId,
            id: channel.id.toLowerCase(),
            name: channel.name,
            epoch,
            isPrivate,
            group: channelGroupKey(secret, bytes32(channel.id, 'channel id'), epoch),
        });
    }
    return out;
}
export class CommunityRuntime {
    constructor(host) {
        this.host = host;
        this.live = new Map();
        this.seen = new Set();
        this.stopped = false;
    }
    /** Start following every given community. */
    async start(records) {
        this.stopped = false;
        for (const record of records) {
            await this.add(record);
        }
    }
    /** Every channel the bot can currently read, across communities. */
    channels(communityId) {
        const communities = communityId ? [this.live.get(communityId)].filter(Boolean) : [...this.live.values()];
        return communities.flatMap((c) => [...c.channels.values()]);
    }
    /**
     * Follow a community. `announce` publishes the guestbook join when the bot
     * has not joined before; an existing join on the relays is adopted instead,
     * since every re-publish shows as "<bot> has joined" to the whole community.
     */
    async add(record, options = {}) {
        if (record.protocol !== 'v2') {
            this.host.log('Skipping community with unsupported protocol', record.protocol, record.communityId);
            return;
        }
        if (record.owner && record.ownerSalt && !verifyCommunityId(record.communityId, record.owner, record.ownerSalt)) {
            this.host.emit('error', new Error(`Community ${record.communityId} does not match its claimed owner; refusing it`));
            return;
        }
        this.remove(record.communityId);
        const community = {
            record,
            channels: new Map(resolveChannels(record).map((c) => [c.group.pk, c])),
            guestbook: guestbookGroupKey(bytes32(record.accessKey), bytes32(record.communityId), record.epoch),
            lastSeen: Math.floor(Date.now() / 1000),
        };
        this.live.set(record.communityId, community);
        this.subscribe(community);
        // In the background: checking the guestbook for an earlier join is a relay
        // round-trip, and reading the channels doesn't depend on it.
        if (options.announce !== false && !record.announced) {
            this.announceJoin(community).catch((error) => {
                this.host.log('Guestbook join failed for', record.communityId, error);
                this.host.emit('error', error);
            });
        }
    }
    /** Stop following a community (keys are the store's business, not ours). */
    remove(communityId) {
        const community = this.live.get(communityId);
        if (!community)
            return;
        if (community.retry)
            clearTimeout(community.retry);
        community.close?.();
        this.live.delete(communityId);
    }
    stop() {
        this.stopped = true;
        for (const id of [...this.live.keys()]) {
            this.remove(id);
        }
    }
    // ── subscription ───────────────────────────────────────────────────────────
    subscribe(community) {
        const authors = [...community.channels.keys(), community.guestbook.pk];
        const relays = community.record.relays;
        if (!relays.length) {
            this.host.emit('error', new Error(`Community ${community.record.communityId} lists no relays`));
            return;
        }
        // Live only: history from before the bot started is not replayed, but a
        // reconnect catches up from the last event seen (with slack for clock skew).
        const since = community.lastSeen - 60;
        const sub = this.host.pool.subscribe(relays, { kinds: [KIND_WRAP, KIND_WRAP_EPHEMERAL], authors, since }, {
            onevent: (event) => this.handleWrap(community, event),
            onclose: (reasons) => {
                if (this.stopped || this.live.get(community.record.communityId) !== community)
                    return;
                this.host.log('Community subscription closed', community.record.communityId, reasons);
                community.retry = setTimeout(() => {
                    if (!this.stopped && this.live.get(community.record.communityId) === community) {
                        this.subscribe(community);
                    }
                }, RESUBSCRIBE_MS);
            },
        });
        community.close = () => sub.close();
    }
    markSeen(key) {
        if (this.seen.has(key))
            return false;
        if (this.seen.size >= SEEN_LIMIT) {
            this.seen.clear();
        }
        this.seen.add(key);
        return true;
    }
    handleWrap(community, wrap) {
        if (!this.markSeen(`w:${wrap.id}`))
            return;
        community.lastSeen = Math.max(community.lastSeen, wrap.created_at);
        const channel = community.channels.get(wrap.pubkey);
        try {
            if (channel) {
                const event = openChatEvent(wrap, channel.group, channel.id, channel.epoch);
                // The same rumor can arrive re-wrapped from several relays.
                if (!this.markSeen(`r:${event.opened.rumor.id}`))
                    return;
                if (event.opened.author === this.host.publicKey)
                    return;
                this.dispatchChat(community, channel, event);
            }
            else if (wrap.pubkey === community.guestbook.pk) {
                const entry = openGuestbookEvent(wrap, community.guestbook);
                const base = { communityId: community.record.communityId, communityName: community.record.name };
                if (entry.type === 'join')
                    this.host.emit('community_member_join', { ...base, member: entry.member, at: entry.atMs, invitedBy: entry.invitedBy });
                else if (entry.type === 'leave')
                    this.host.emit('community_member_leave', { ...base, member: entry.member, at: entry.atMs });
                else
                    this.host.emit('community_member_kick', { ...base, author: entry.author, target: entry.target, at: entry.atMs });
            }
        }
        catch (error) {
            // A wrap that fails verification is dropped, never surfaced as chat.
            this.host.log('Dropped community wrap', wrap.id, error.message);
        }
    }
    dispatchChat(community, channel, event) {
        const { opened } = event;
        const base = {
            communityId: community.record.communityId,
            communityName: community.record.name,
            channelId: channel.id,
            channelName: channel.name,
            author: opened.author,
            createdAt: opened.atMs,
        };
        switch (event.type) {
            case 'message': {
                const message = {
                    ...base,
                    id: opened.rumor.id,
                    content: opened.rumor.content,
                    kind: opened.rumor.kind,
                    replyTo: event.replyTo,
                    emoji: event.emoji,
                    rumor: opened.rumor,
                    reply: (content) => this.send(community.record.communityId, channel.id, content, {
                        replyTo: { id: opened.rumor.id, author: opened.author },
                    }),
                    react: (emoji) => this.react(community.record.communityId, channel.id, { id: opened.rumor.id, author: opened.author, kind: opened.rumor.kind }, emoji),
                };
                this.host.emit('community_message', message);
                break;
            }
            case 'reaction':
                this.host.emit('community_reaction', { ...base, id: opened.rumor.id, target: event.target, targetAuthor: event.targetAuthor, emoji: event.emoji, emojiUrl: event.emojiUrl });
                break;
            case 'edit':
                this.host.emit('community_message_update', { ...base, id: opened.rumor.id, target: event.target, content: event.newContent });
                break;
            case 'delete':
                this.host.emit('community_message_delete', { ...base, id: opened.rumor.id, target: event.target, targetKind: event.targetKind });
                break;
            case 'typing':
                this.host.emit('community_typing', base);
                break;
            default:
                break;
        }
    }
    // ── guestbook ──────────────────────────────────────────────────────────────
    /** Whether the bot already has a join on the community's guestbook. */
    async hasJoined(community) {
        const wraps = await this.host.pool.querySync(community.record.relays, { kinds: [KIND_WRAP], authors: [community.guestbook.pk] }, { maxWait: 8000 });
        return wraps.some((wrap) => {
            try {
                const entry = openGuestbookEvent(wrap, community.guestbook);
                return entry.type === 'join' && entry.member === this.host.publicKey;
            }
            catch {
                return false;
            }
        });
    }
    async announceJoin(community) {
        const { record } = community;
        if (!(await this.hasJoined(community))) {
            // Attribution echoes the invite: the seal-verified inviter, else the
            // bundle's creator, with its label (CORD-05 §1).
            const creator = record.invitedBy || record.inviteCreator;
            const rumor = buildJoinRumor(this.host.publicKey, creator ? { creator, label: record.inviteLabel ?? '' } : undefined);
            await this.host.publish(sealGuestbookRumor(rumor, community.guestbook, this.host.privateKey), record.relays);
            this.host.log('Announced join to', record.name);
        }
        record.announced = true;
        await this.host.save(record);
        this.host.emit('community_announced', { communityId: record.communityId, communityName: record.name });
    }
    /** Publish the guestbook leave. Call before discarding the community's keys. */
    async announceLeave(record) {
        if (record.protocol !== 'v2' || !record.announced)
            return;
        const guestbook = guestbookGroupKey(bytes32(record.accessKey), bytes32(record.communityId), record.epoch);
        await this.host.publish(sealGuestbookRumor(buildLeaveRumor(this.host.publicKey), guestbook, this.host.privateKey), record.relays);
    }
    // ── sending ────────────────────────────────────────────────────────────────
    channel(communityId, channelId) {
        const community = this.live.get(communityId);
        if (!community) {
            throw new Error(`Not in community ${communityId}. Joined: ${[...this.live.keys()].join(', ') || 'none'}`);
        }
        const id = channelId.toLowerCase();
        const byName = channelId.replace(/^#/, '').toLowerCase();
        const channel = [...community.channels.values()].find((c) => c.id === id || c.name?.toLowerCase() === byName);
        if (!channel) {
            const known = [...community.channels.values()].map((c) => `${c.name ?? '?'} (${c.id})`).join(', ');
            throw new Error(`No readable channel ${channelId} in ${community.record.name}. Channels: ${known || 'none'}`);
        }
        return { community, channel };
    }
    async publishChat(community, channel, rumor, ephemeral = false) {
        const wrap = sealChatRumor(rumor, channel.group, this.host.privateKey, { ephemeral });
        this.markSeen(`r:${rumor.id}`);
        await this.host.publish(wrap, community.record.relays);
        return { id: rumor.id, sent: true };
    }
    /** Post a message in a channel (by id or name). */
    async send(communityId, channelId, content, options = {}) {
        const { community, channel } = this.channel(communityId, channelId);
        const extraTags = options.expiration ? [['expiration', String(options.expiration)]] : [];
        const rumor = buildMessageRumor(this.host.publicKey, channel.id, channel.epoch, content, {
            replyTo: options.replyTo,
            emoji: options.emoji,
            extraTags,
        });
        return this.publishChat(community, channel, rumor);
    }
    async react(communityId, channelId, target, emoji, options = {}) {
        const { community, channel } = this.channel(communityId, channelId);
        return this.publishChat(community, channel, buildReactionRumor(this.host.publicKey, channel.id, channel.epoch, target, emoji, options));
    }
    /** Edit one of the bot's own messages. */
    async edit(communityId, channelId, messageId, content) {
        const { community, channel } = this.channel(communityId, channelId);
        return this.publishChat(community, channel, buildEditRumor(this.host.publicKey, channel.id, channel.epoch, messageId, content));
    }
    /** Delete one of the bot's own messages. */
    async delete(communityId, channelId, messageId) {
        const { community, channel } = this.channel(communityId, channelId);
        return this.publishChat(community, channel, buildDeleteRumor(this.host.publicKey, channel.id, channel.epoch, messageId, ChatKind.MESSAGE));
    }
    /** Show a typing indicator (ephemeral; relays don't store it). */
    async typing(communityId, channelId) {
        const { community, channel } = this.channel(communityId, channelId);
        return this.publishChat(community, channel, buildTypingRumor(this.host.publicKey, channel.id, channel.epoch), true);
    }
}
