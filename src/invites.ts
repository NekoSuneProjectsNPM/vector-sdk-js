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

import { COMMUNITY_DIRECT_INVITE, COMMUNITY_INVITE_BUNDLE } from './kinds.js';

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

/** Concord v2 caps, from `vector_core::community::v2::invite`. */
export const MAX_BUNDLE_CHANNELS = 256;
export const MAX_BOOTSTRAP_RELAYS = 3;
export const MAX_BUNDLE_EPOCH = 2 ** 40;

export class InviteError extends Error {}

/**
 * One channel described by an invite bundle.
 *
 * In a v2 bundle this is a *grant*: `key` is the channel's actual access key,
 * so a channel listed with one is a channel the invite lets you read.
 */
export interface InviteChannel {
  id: string;
  name?: string;
  epoch?: number;
  isPrivate?: boolean;
  /** Channel key (v2 grants only). Secret. */
  key?: string;
}

/**
 * Which protocol generation an invite came from.
 *
 * `v2` (kind 3313) is what a current Vector app sends. `v1` (kind 3304) is the
 * older bundle. Both are read here; only the shape of the JSON differs.
 */
export type InviteProtocol = 'v1' | 'v2';

/** A community invite bundle. */
export interface CommunityInvite {
  /** Which generation of the protocol issued this invite. */
  protocol: InviteProtocol;
  communityId: string;
  name: string;
  /**
   * The base access key. Secret — this is what the bundle actually grants.
   *
   * `server_root_key` in a v1 bundle, `community_root` in a v2 one. The two
   * generations name it differently on the wire; this is the common handle.
   */
  accessKey: string;
  /** The epoch that `accessKey` belongs to, so a joiner reads at the right clock. */
  epoch: number;
  /** Owner x-only pubkey, hex (v2). The community id self-certifies from it. */
  owner?: string;
  /** Owner salt, hex (v2). */
  ownerSalt?: string;
  /** The control plane's signer pubkey at `epoch` (v2, optional). */
  controlPk?: string;
  /** Who created the invite, echoed in the joiner's guestbook entry (v2). */
  creatorNpub?: string;
  /** Free-text label the inviter attached (v2). */
  label?: string;
  relays: string[];
  channels: InviteChannel[];
  /** Signed event JSON proving who the owner is, when the sender included it. */
  ownerAttestation?: string;
  /** The bundle's own deadline in Unix MILLISECONDS, when it declares one (v2). */
  expiresAtMs?: number;
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
  const protocol: InviteProtocol | null =
    rumor.kind === COMMUNITY_DIRECT_INVITE
      ? 'v2'
      : rumor.kind === COMMUNITY_INVITE_BUNDLE
        ? 'v1'
        : null;
  if (!protocol) {
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
  if (!communityId) {
    return null;
  }

  // The two generations name the access key differently on the wire, and the
  // names are frozen — Soapbox and Armada read the same bytes, so a rename is a
  // silent cross-client join failure. Read both, expose one.
  const accessKey =
    protocol === 'v2'
      ? boundedString(parsed.community_root ?? parsed.communityRoot, 1024)
      : boundedString(parsed.server_root_key ?? parsed.serverRootKey, 1024);

  if (!accessKey) {
    return null; // without it the bundle grants nothing
  }

  const rawEpoch =
    protocol === 'v2'
      ? (parsed.root_epoch ?? parsed.rootEpoch)
      : (parsed.server_root_epoch ?? parsed.serverRootEpoch);
  const epoch =
    typeof rawEpoch === 'number' && rawEpoch >= 0 && rawEpoch <= MAX_BUNDLE_EPOCH
      ? rawEpoch
      : 0;

  const relayCap = protocol === 'v2' ? MAX_BOOTSTRAP_RELAYS : MAX_INVITE_RELAYS;
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
    if (relays.length >= relayCap) {
      break;
    }
  }

  // A v2 bundle may omit `channels` entirely when it vends no keys. Treating a
  // missing list as fatal would turn a keyless invite into a parse failure.
  const channelCap = protocol === 'v2' ? MAX_BUNDLE_CHANNELS : MAX_INVITE_CHANNELS;
  const rawChannels = Array.isArray(parsed.channels) ? parsed.channels : [];
  const channels: InviteChannel[] = [];
  for (const entry of rawChannels.slice(0, channelCap)) {
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
      key: boundedString(channel.key, 1024),
      isPrivate:
        typeof channel.is_private === 'boolean'
          ? channel.is_private
          : typeof channel.isPrivate === 'boolean'
            ? channel.isPrivate
            : undefined,
    });
  }

  // A v2 bundle declares its own deadline in MILLISECONDS, alongside (and
  // sometimes instead of) the wrap's NIP-40 tag in seconds.
  const expiresAtMs = parsed.expires_at ?? parsed.expiresAt;

  return {
    protocol,
    communityId,
    name: boundedString(parsed.name, 256) ?? '',
    accessKey,
    epoch,
    owner: boundedString(parsed.owner, 128),
    ownerSalt: boundedString(parsed.owner_salt ?? parsed.ownerSalt, 128),
    controlPk: boundedString(parsed.control_pk ?? parsed.controlPk, 128),
    creatorNpub: boundedString(parsed.creator_npub ?? parsed.creatorNpub, 128),
    label: boundedString(parsed.label, 256),
    relays,
    channels,
    ownerAttestation: boundedString(
      parsed.owner_attestation ?? parsed.ownerAttestation,
      MAX_INVITE_BYTES,
    ),
    expiresAtMs: typeof expiresAtMs === 'number' ? expiresAtMs : undefined,
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

  // The wrap's NIP-40 tag is in seconds; a v2 bundle also states its own
  // deadline in milliseconds. Either can be absent, so take whichever is
  // present and prefer the tag when both are.
  const fromTag = expirationSeconds(rumor.tags);
  const fromBundle =
    invite.expiresAtMs !== undefined ? Math.floor(invite.expiresAtMs / 1000) : undefined;
  const expiresAt = fromTag ?? fromBundle;

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
    kind: invite.protocol === 'v2' ? COMMUNITY_DIRECT_INVITE : COMMUNITY_INVITE_BUNDLE,
    created_at: now,
    tags: [['expiration', Math.floor(expiresAt).toString()]],
    content: JSON.stringify(invite.raw),
  };
}

/** True when `kind` is either generation's invite. */
export function isInviteKind(kind: number): boolean {
  return kind === COMMUNITY_INVITE_BUNDLE || kind === COMMUNITY_DIRECT_INVITE;
}

/** Re-export so callers can filter on the kinds without a second import. */
export { COMMUNITY_INVITE_BUNDLE, COMMUNITY_DIRECT_INVITE };
export type { Event };
