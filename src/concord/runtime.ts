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
import { attachmentsFromRumor, downloadCommunityAttachment, stripAttachmentUrls } from './attachments.js';
import type { CommunityAttachment } from './attachments.js';
import {
  buildDeleteRumor,
  buildEditRumor,
  buildMessageRumor,
  buildReactionRumor,
  buildTypingRumor,
  ChatKind,
  openChatEvent,
  sealChatRumor,
} from './chat.js';
import type { ChatEvent } from './chat.js';
import { bytes32, channelGroupKey, guestbookGroupKey, verifyCommunityId } from './derive.js';
import type { GroupKey } from './derive.js';
import { buildJoinRumor, buildLeaveRumor, openGuestbookEvent, sealGuestbookRumor } from './guestbook.js';
import { KIND_WRAP, KIND_WRAP_EPHEMERAL } from './stream.js';
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
  /** The caption, with any inlined attachment blob URLs removed. */
  content: string;
  /** Files carried as NIP-92 imeta tags (encrypted; use {@link download}). */
  attachments: CommunityAttachment[];
  /** True send time in ms. */
  createdAt: number;
  /** Kind 9 (message) or 1111 (threaded comment). */
  kind: number;
  replyTo?: { id: string; author?: string };
  emoji: [string, string][];
  rumor: Rumor;
  /** Reply in the same channel, quoting this message. */
  reply(content: string): Promise<CommunitySendResult>;
  /** React to this message. */
  react(emoji: string): Promise<CommunitySendResult>;
  /** Download and decrypt one of this message's attachments. */
  download(attachment: CommunityAttachment, options?: { maxBytes?: number }): Promise<Buffer>;
}

interface LiveCommunity {
  record: JoinedCommunity;
  channels: Map<string, LiveChannel>;
  guestbook: GroupKey;
  close?: () => void;
  lastSeen: number;
  retry?: ReturnType<typeof setTimeout>;
}

const SEEN_LIMIT = 5000;
const RESUBSCRIBE_MS = 10_000;

/**
 * Resolve an invite's channel grants to their keys (CORD-03 §1): a public
 * channel reads under the community root at the root epoch; a private one
 * under its own key at its own epoch.
 */
export function resolveChannels(record: JoinedCommunity): LiveChannel[] {
  const root = bytes32(record.accessKey, 'community access key');
  const out: LiveChannel[] = [];
  for (const channel of record.channels) {
    const isPrivate = Boolean(channel.isPrivate);
    if (isPrivate && !channel.key) {
      continue; // listed but not granted
    }
    const secret = isPrivate ? bytes32(channel.key as string, 'channel key') : root;
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
  private readonly live = new Map<string, LiveCommunity>();
  private readonly seen = new Set<string>();
  private stopped = false;

  constructor(private readonly host: CommunityRuntimeHost) {}

  /** Start following every given community. */
  public async start(records: JoinedCommunity[]): Promise<void> {
    this.stopped = false;
    for (const record of records) {
      await this.add(record);
    }
  }

  /** Every channel the bot can currently read, across communities. */
  public channels(communityId?: string): LiveChannel[] {
    const communities = communityId ? [this.live.get(communityId)].filter(Boolean) : [...this.live.values()];
    return (communities as LiveCommunity[]).flatMap((c) => [...c.channels.values()]);
  }

  /**
   * Follow a community. `announce` publishes the guestbook join when the bot
   * has not joined before; an existing join on the relays is adopted instead,
   * since every re-publish shows as "<bot> has joined" to the whole community.
   */
  public async add(record: JoinedCommunity, options: { announce?: boolean } = {}): Promise<void> {
    if (record.protocol !== 'v2') {
      this.host.log('Skipping community with unsupported protocol', record.protocol, record.communityId);
      return;
    }
    if (record.owner && record.ownerSalt && !verifyCommunityId(record.communityId, record.owner, record.ownerSalt)) {
      this.host.emit('error', new Error(`Community ${record.communityId} does not match its claimed owner; refusing it`));
      return;
    }

    this.remove(record.communityId);
    const community: LiveCommunity = {
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
  public remove(communityId: string): void {
    const community = this.live.get(communityId);
    if (!community) return;
    if (community.retry) clearTimeout(community.retry);
    community.close?.();
    this.live.delete(communityId);
  }

  public stop(): void {
    this.stopped = true;
    for (const id of [...this.live.keys()]) {
      this.remove(id);
    }
  }

  // ── subscription ───────────────────────────────────────────────────────────

  private subscribe(community: LiveCommunity): void {
    const authors = [...community.channels.keys(), community.guestbook.pk];
    const relays = community.record.relays;
    if (!relays.length) {
      this.host.emit('error', new Error(`Community ${community.record.communityId} lists no relays`));
      return;
    }

    // Live only: history from before the bot started is not replayed, but a
    // reconnect catches up from the last event seen (with slack for clock skew).
    const since = community.lastSeen - 60;
    const sub = this.host.pool.subscribe(
      relays,
      { kinds: [KIND_WRAP, KIND_WRAP_EPHEMERAL], authors, since },
      {
        onevent: (event: Event) => this.handleWrap(community, event),
        onclose: (reasons: string[]) => {
          if (this.stopped || this.live.get(community.record.communityId) !== community) return;
          this.host.log('Community subscription closed', community.record.communityId, reasons);
          community.retry = setTimeout(() => {
            if (!this.stopped && this.live.get(community.record.communityId) === community) {
              this.subscribe(community);
            }
          }, RESUBSCRIBE_MS);
        },
      },
    );
    community.close = () => sub.close();
  }

  private markSeen(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= SEEN_LIMIT) {
      this.seen.clear();
    }
    this.seen.add(key);
    return true;
  }

  private handleWrap(community: LiveCommunity, wrap: Event): void {
    if (!this.markSeen(`w:${wrap.id}`)) return;
    community.lastSeen = Math.max(community.lastSeen, wrap.created_at);

    const channel = community.channels.get(wrap.pubkey);
    try {
      if (channel) {
        const event = openChatEvent(wrap, channel.group, channel.id, channel.epoch);
        // The same rumor can arrive re-wrapped from several relays.
        if (!this.markSeen(`r:${event.opened.rumor.id}`)) return;
        if (event.opened.author === this.host.publicKey) return;
        this.dispatchChat(community, channel, event);
      } else if (wrap.pubkey === community.guestbook.pk) {
        const entry = openGuestbookEvent(wrap, community.guestbook);
        const base = { communityId: community.record.communityId, communityName: community.record.name };
        if (entry.type === 'join') this.host.emit('community_member_join', { ...base, member: entry.member, at: entry.atMs, invitedBy: entry.invitedBy });
        else if (entry.type === 'leave') this.host.emit('community_member_leave', { ...base, member: entry.member, at: entry.atMs });
        else this.host.emit('community_member_kick', { ...base, author: entry.author, target: entry.target, at: entry.atMs });
      }
    } catch (error) {
      // A wrap that fails verification is dropped, never surfaced as chat.
      this.host.log('Dropped community wrap', wrap.id, (error as Error).message);
    }
  }

  private dispatchChat(community: LiveCommunity, channel: LiveChannel, event: ChatEvent): void {
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
        const attachments = attachmentsFromRumor(opened.rumor);
        const message: CommunityMessage = {
          ...base,
          id: opened.rumor.id,
          content: stripAttachmentUrls(opened.rumor.content, attachments),
          attachments,
          download: (attachment, options) => downloadCommunityAttachment(attachment, options),
          kind: opened.rumor.kind,
          replyTo: event.replyTo,
          emoji: event.emoji,
          rumor: opened.rumor,
          reply: (content) =>
            this.send(community.record.communityId, channel.id, content, {
              replyTo: { id: opened.rumor.id, author: opened.author },
            }),
          react: (emoji) =>
            this.react(community.record.communityId, channel.id, { id: opened.rumor.id, author: opened.author, kind: opened.rumor.kind }, emoji),
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
  private async hasJoined(community: LiveCommunity): Promise<boolean> {
    const wraps = await this.host.pool.querySync(community.record.relays, { kinds: [KIND_WRAP], authors: [community.guestbook.pk] }, { maxWait: 8000 });
    return wraps.some((wrap) => {
      try {
        const entry = openGuestbookEvent(wrap, community.guestbook);
        return entry.type === 'join' && entry.member === this.host.publicKey;
      } catch {
        return false;
      }
    });
  }

  private async announceJoin(community: LiveCommunity): Promise<void> {
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
  public async announceLeave(record: JoinedCommunity): Promise<void> {
    if (record.protocol !== 'v2' || !record.announced) return;
    const guestbook = guestbookGroupKey(bytes32(record.accessKey), bytes32(record.communityId), record.epoch);
    await this.host.publish(sealGuestbookRumor(buildLeaveRumor(this.host.publicKey), guestbook, this.host.privateKey), record.relays);
  }

  // ── sending ────────────────────────────────────────────────────────────────

  private channel(communityId: string, channelId: string): { community: LiveCommunity; channel: LiveChannel } {
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

  private async publishChat(community: LiveCommunity, channel: LiveChannel, rumor: Rumor, ephemeral = false): Promise<CommunitySendResult> {
    const wrap = sealChatRumor(rumor, channel.group, this.host.privateKey, { ephemeral });
    this.markSeen(`r:${rumor.id}`);
    await this.host.publish(wrap, community.record.relays);
    return { id: rumor.id, sent: true };
  }

  /** Post a message in a channel (by id or name). */
  public async send(
    communityId: string,
    channelId: string,
    content: string,
    options: { replyTo?: { id: string; author: string }; emoji?: [string, string][]; expiration?: number } = {},
  ): Promise<CommunitySendResult> {
    const { community, channel } = this.channel(communityId, channelId);
    const extraTags = options.expiration ? [['expiration', String(options.expiration)]] : [];
    const rumor = buildMessageRumor(this.host.publicKey, channel.id, channel.epoch, content, {
      replyTo: options.replyTo,
      emoji: options.emoji,
      extraTags,
    });
    return this.publishChat(community, channel, rumor);
  }

  public async react(
    communityId: string,
    channelId: string,
    target: { id: string; author: string; kind?: number },
    emoji: string,
    options: { emojiUrl?: string } = {},
  ): Promise<CommunitySendResult> {
    const { community, channel } = this.channel(communityId, channelId);
    return this.publishChat(community, channel, buildReactionRumor(this.host.publicKey, channel.id, channel.epoch, target, emoji, options));
  }

  /** Edit one of the bot's own messages. */
  public async edit(communityId: string, channelId: string, messageId: string, content: string): Promise<CommunitySendResult> {
    const { community, channel } = this.channel(communityId, channelId);
    return this.publishChat(community, channel, buildEditRumor(this.host.publicKey, channel.id, channel.epoch, messageId, content));
  }

  /** Delete one of the bot's own messages. */
  public async delete(communityId: string, channelId: string, messageId: string): Promise<CommunitySendResult> {
    const { community, channel } = this.channel(communityId, channelId);
    return this.publishChat(community, channel, buildDeleteRumor(this.host.publicKey, channel.id, channel.epoch, messageId, ChatKind.MESSAGE));
  }

  /** Show a typing indicator (ephemeral; relays don't store it). */
  public async typing(communityId: string, channelId: string): Promise<CommunitySendResult> {
    const { community, channel } = this.channel(communityId, channelId);
    return this.publishChat(community, channel, buildTypingRumor(this.host.publicKey, channel.id, channel.epoch), true);
  }
}
