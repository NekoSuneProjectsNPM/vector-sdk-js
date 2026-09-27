/**
 * Community invites (kind 3304).
 *
 * An invite is a JSON bundle gift-wrapped to the invitee over NIP-17 — the same
 * private-DM path as any other message. The bundle is plain JSON inside the
 * wrap, so reading one, checking it and passing it on are all things this
 * package can do.
 *
 * What it cannot do is *mint* one. A bundle hands out live key material for the
 * community (`serverRootKey`, per-channel epoch keys, the owner attestation),
 * which only a member holding that community's state can produce — and that
 * state lives in `vector-core`. So a bot forwards invites it was given; it does
 * not create them.
 *
 * A bundle is live key material and arrives over an unauthenticated gift wrap
 * from an arbitrary sender, so it is untrusted input: every field is bounded on
 * read, matching `vector_core::community::invite`.
 */

import type { Event } from 'nostr-tools';

import { COMMUNITY_INVITE_BUNDLE } from './kinds.js';

/**
 * How long a direct invite stays valid, in seconds.
 *
 * A bundle carries keys for a community that keeps evolving — rotations,
 * renames, bans — so an invite that never expired would be stale key material.
 * Senders stamp NIP-40 on the rumor and the wrap, but relay support for NIP-40
 * is optional, so receivers enforce the expiry themselves.
 */
export const DIRECT_INVITE_EXPIRY_SECS = 24 * 60 * 60;

/**
 * Caps on a received bundle. A hostile sender could otherwise declare an
 * unbounded channel or relay list and force mass allocation on every recipient.
 */
export const MAX_INVITE_RELAYS = 5;
export const MAX_INVITE_CHANNELS = 64;
export const MAX_INVITE_BYTES = 256 * 1024;

export class InviteError extends Error {}

/** One channel described by an invite bundle. */
export interface InviteChannel {
  id: string;
  name?: string;
  epoch?: number;
  isPrivate?: boolean;
}

/** A community invite bundle, as carried by a kind-3304 rumor. */
export interface CommunityInvite {
  communityId: string;
  name: string;
  /** The community's server-root key. Secret — this is what grants access. */
  serverRootKey: string;
  /** The server root's current epoch, so a joiner adopts the right read clock. */
  serverRootEpoch: number;
  relays: string[];
  channels: InviteChannel[];
  /** Signed event JSON proving who the owner is, when the sender included it. */
  ownerAttestation?: string;
  /** The raw bundle, exactly as it arrived. Forwarding re-sends this verbatim. */
  raw: Record<string, unknown>;
}

/** An invite as received, with the envelope details a caller needs to act on it. */
export interface ReceivedInvite {
  invite: CommunityInvite;
  /** Who sent it, hex pubkey. */
  senderPubkey: string;
  /** The rumor id. */
  messageId?: string;
  /** NIP-40 expiry in Unix seconds, when the sender declared one. */
  expiresAt?: number;
  /** Whether that expiry has already passed. */
  expired: boolean;
}

/** Read a NIP-40 `expiration` tag (Unix seconds) off a rumor's tags. */
export function expirationSeconds(tags: string[][]): number | undefined {
  const tag = tags.find((candidate) => candidate[0] === 'expiration');
  if (!tag || typeof tag[1] !== 'string') {
    return undefined;
  }
  const parsed = Number.parseInt(tag[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedString(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

/**
 * Parse a rumor's content as a community invite bundle.
 *
 * Returns `null` rather than throwing when the rumor is not an invite or the
 * bundle is malformed, so an inbound dispatcher can simply fall through to
 * treating it as an ordinary message.
 */
export function parseCommunityInvite(rumor: {
  kind: number;
  content: string;
}): CommunityInvite | null {
  if (rumor.kind !== COMMUNITY_INVITE_BUNDLE) {
    return null;
  }
  if (!rumor.content || Buffer.byteLength(rumor.content, 'utf8') > MAX_INVITE_BYTES) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rumor.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const communityId = boundedString(parsed.community_id ?? parsed.communityId, 256);
  const serverRootKey = boundedString(parsed.server_root_key ?? parsed.serverRootKey, 1024);
  if (!communityId || !serverRootKey) {
    return null; // without these the bundle grants nothing
  }

  const rawRelays = Array.isArray(parsed.relays) ? parsed.relays : [];
  const relays: string[] = [];
  const seenRelays = new Set<string>();
  for (const entry of rawRelays) {
    const relay = boundedString(entry, 512);
    if (!relay || seenRelays.has(relay)) {
      continue;
    }
    seenRelays.add(relay);
    relays.push(relay);
    if (relays.length >= MAX_INVITE_RELAYS) {
      break;
    }
  }

  const rawChannels = Array.isArray(parsed.channels) ? parsed.channels : [];
  const channels: InviteChannel[] = [];
  for (const entry of rawChannels.slice(0, MAX_INVITE_CHANNELS)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const channel = entry as Record<string, unknown>;
    const id = boundedString(channel.id, 256);
    if (!id) {
      continue;
    }
    channels.push({
      id,
      name: boundedString(channel.name, 256),
      epoch: typeof channel.epoch === 'number' ? channel.epoch : undefined,
      isPrivate:
        typeof channel.is_private === 'boolean'
          ? channel.is_private
          : typeof channel.isPrivate === 'boolean'
            ? channel.isPrivate
            : undefined,
    });
  }

  const epoch = parsed.server_root_epoch ?? parsed.serverRootEpoch;

  return {
    communityId,
    name: boundedString(parsed.name, 256) ?? '',
    serverRootKey,
    serverRootEpoch: typeof epoch === 'number' ? epoch : 0,
    relays,
    channels,
    ownerAttestation: boundedString(
      parsed.owner_attestation ?? parsed.ownerAttestation,
      MAX_INVITE_BYTES,
    ),
    raw: parsed,
  };
}

/**
 * Read an unwrapped gift-wrap rumor as a received invite.
 *
 * Returns `null` when the rumor is not an invite. An expired invite is still
 * returned, flagged — the caller decides whether a stale invite is worth
 * surfacing, and silently dropping one would look like it never arrived.
 */
export function readInviteRumor(
  rumor: { kind: number; content: string; tags: string[][]; pubkey: string; id?: string },
  now: number = Math.floor(Date.now() / 1000),
): ReceivedInvite | null {
  const invite = parseCommunityInvite(rumor);
  if (!invite) {
    return null;
  }

  const expiresAt = expirationSeconds(rumor.tags);
  return {
    invite,
    senderPubkey: rumor.pubkey,
    messageId: rumor.id,
    expiresAt,
    expired: expiresAt !== undefined && expiresAt <= now,
  };
}

/**
 * Build the rumor that carries `invite` to someone else.
 *
 * The bundle is re-sent verbatim, because it is the community's key material
 * and not ours to rewrite. The NIP-40 expiry is preserved when the original
 * had one, so forwarding cannot extend an invite's life beyond what the issuer
 * granted; an invite with no declared expiry gets the standard 24 hours.
 */
export function buildInviteRumor(
  invite: CommunityInvite,
  options: { expiresAt?: number } = {},
): { kind: number; created_at: number; tags: string[][]; content: string } {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = options.expiresAt ?? now + DIRECT_INVITE_EXPIRY_SECS;

  return {
    kind: COMMUNITY_INVITE_BUNDLE,
    created_at: now,
    tags: [['expiration', Math.floor(expiresAt).toString()]],
    content: JSON.stringify(invite.raw),
  };
}

/** True when `event` is a gift wrap that might carry an invite. */
export function isInviteKind(kind: number): boolean {
  return kind === COMMUNITY_INVITE_BUNDLE;
}

/** Re-export so callers can filter on the kind without a second import. */
export { COMMUNITY_INVITE_BUNDLE };
export type { Event };
