/**
 * CORD-01 Private Streams: the Concord v2 envelope.
 *
 * A port of `vector-core/src/community/v2/stream.rs`. Every durable plane event
 * has the same three layers: a kind-1059 **wrap** signed by the plane's derived
 * group key (fixed author, random ephemeral `p` tag: NIP-59 reversed), holding
 * a **seal** signed by the author's real key, holding the unsigned **rumor**
 * that carries the functional kind.
 *
 * Two seal forms, fixed per plane:
 *   - 20013 encrypted (chat, guestbook, rekey): the rumor is NIP-44-encrypted
 *     again inside the already-encrypted wrap.
 *   - 20014 plaintext (control plane only): the seal content is the rumor JSON
 *     byte-verbatim, which lets a compaction re-wrap a signed edition.
 *
 * Ephemeral actions (typing) use the identical structure at kind 21059.
 */
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip44, verifyEvent } from 'nostr-tools';
import type { Event } from 'nostr-tools';

import type { GroupKey } from './derive.js';

export const KIND_WRAP = 1059;
export const KIND_WRAP_EPHEMERAL = 21059;
export const KIND_SEAL_ENCRYPTED = 20013;
export const KIND_SEAL_PLAINTEXT = 20014;

/** NIP-44 v2 plaintext hard cap, enforced at every nesting layer. */
export const NIP44_MAX_PLAINTEXT = 65_535;

export type SealForm = 'encrypted' | 'plaintext';

/** An unsigned rumor, the inner event every plane carries. */
export interface Rumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** A fully verified, opened stream event. */
export interface OpenedStream {
  /** The rumor, its id recomputed from its fields (never the claimed one). */
  rumor: Rumor;
  /** The real author: the seal's verified signer, equal to the rumor pubkey. */
  author: string;
  sealForm: SealForm;
  /** The verified seal, kept so a plaintext seal can be re-wrapped verbatim. */
  seal: Event;
  /** The outer wrap's id (per-transport; differs on every re-wrap). */
  wrapperId: string;
  /** True event time in ms: `created_at * 1000 + ms tag`. */
  atMs: number;
}

export class StreamError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
  }
}

const encoder = new TextEncoder();

function cap(json: string): void {
  const size = encoder.encode(json).length;
  if (size > NIP44_MAX_PLAINTEXT) {
    throw new StreamError('oversize', `${size} bytes exceeds the NIP-44 cap`);
  }
}

// ── millisecond ordering (CORD-02 §4) ────────────────────────────────────────

/**
 * A rumor's true millisecond time, strict per CORD-02 §5: no `ms` tag means
 * offset 0; a present `ms` tag that is not a lone 0..=999 decimal without
 * leading zeros makes the event malformed (dropped, never clamped). The first
 * occurrence wins, matching Armada.
 */
export function resolveMsStrict(rumor: Pick<Rumor, 'created_at' | 'tags'>): number {
  const secs = rumor.created_at;
  const tag = rumor.tags.find((t) => t[0] === 'ms');
  if (!tag) {
    return secs * 1000;
  }
  const raw = tag[1];
  if (raw === undefined || raw === '' || !/^[0-9]+$/.test(raw)) {
    throw new StreamError('bad-ms');
  }
  const n = Number(raw);
  if (n > 999 || (raw.length > 1 && raw.startsWith('0'))) {
    throw new StreamError('bad-ms');
  }
  return secs * 1000 + n;
}

// ── build side ───────────────────────────────────────────────────────────────

function finishRumor(kind: number, author: string, content: string, tags: string[][], createdAt: number): Rumor {
  const base = { pubkey: author, created_at: createdAt, kind, tags, content };
  return { ...base, id: getEventHash(base) };
}

/**
 * An unsigned rumor with a full epoch-ms time: `created_at` takes the seconds,
 * an `["ms", <0..999>]` tag appended last takes the remainder.
 */
export function buildRumorMs(kind: number, author: string, content: string, tags: string[][], atMs: number): Rumor {
  const secs = Math.floor(atMs / 1000);
  return finishRumor(kind, author, content, [...tags, ['ms', String(atMs % 1000)]], secs);
}

/** An unsigned rumor with a seconds timestamp and no `ms` tag (control plane shape). */
export function buildRumorSecs(kind: number, author: string, content: string, tags: string[][], atSecs: number): Rumor {
  return finishRumor(kind, author, content, tags, atSecs);
}

/** Seal a rumor with the author's real key. */
export function buildSeal(rumor: Rumor, form: SealForm, group: GroupKey, authorSk: Uint8Array): Event {
  const json = JSON.stringify(rumor);
  cap(json);
  const content = form === 'plaintext' ? json : nip44.v2.encrypt(json, group.convKey);
  return finalizeEvent(
    {
      kind: form === 'plaintext' ? KIND_SEAL_PLAINTEXT : KIND_SEAL_ENCRYPTED,
      created_at: rumor.created_at,
      tags: [],
      content,
    },
    authorSk,
  );
}

/**
 * Wrap a signed seal into the outer stream event: NIP-44 under the stream's
 * conversation key, signed by the group key, one random ephemeral `p` tag.
 * `wrapAt` is the untweaked wall clock (CORD-01 forbids NIP-59's tweak here).
 */
export function wrapSeal(
  seal: Event,
  group: GroupKey,
  options: { kind?: number; wrapAt?: number; extraTags?: string[][] } = {},
): Event {
  const kind = options.kind ?? KIND_WRAP;
  if (kind !== KIND_WRAP && kind !== KIND_WRAP_EPHEMERAL) {
    throw new StreamError('bad-wrap-kind', String(kind));
  }
  const sealJson = JSON.stringify(seal);
  cap(sealJson);
  const ephemeral = getPublicKey(generateSecretKey());
  return finalizeEvent(
    {
      kind,
      created_at: options.wrapAt ?? Math.floor(Date.now() / 1000),
      tags: [['p', ephemeral], ...(options.extraTags ?? [])],
      content: nip44.v2.encrypt(sealJson, group.convKey),
    },
    group.sk,
  );
}

// ── open side ────────────────────────────────────────────────────────────────

function openNip44(convKey: Uint8Array, payload: string): string {
  try {
    return nip44.v2.decrypt(payload, convKey);
  } catch (error) {
    throw new StreamError('decrypt', (error as Error).message);
  }
}

function parseJson<T>(json: string, what: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new StreamError('parse', `${what}: ${(error as Error).message}`);
  }
}

function isRumorShape(value: unknown): value is Omit<Rumor, 'id'> & { id?: string } {
  const r = value as Record<string, unknown>;
  return (
    !!r &&
    typeof r.pubkey === 'string' &&
    typeof r.created_at === 'number' &&
    typeof r.kind === 'number' &&
    typeof r.content === 'string' &&
    Array.isArray(r.tags) &&
    r.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))
  );
}

/**
 * Open and fully verify a stream wrap against a plane's address and
 * conversation key.
 *
 * Chain: wrap kind → wrap author is the stream address → decrypt (the NIP-44
 * MAC under the members-only key is the envelope gate) → seal kind → seal
 * Schnorr verify → rumor pubkey equals seal pubkey → rumor id recomputed and
 * compared with any claimed id → strict `ms`. `verifyWrapSig` is for a
 * write-restricted stream (the control plane), where the wrap signature is
 * the write gate.
 */
export function openWrapAt(wrap: Event, address: string, convKey: Uint8Array, verifyWrapSig = false): OpenedStream {
  if (wrap.kind !== KIND_WRAP && wrap.kind !== KIND_WRAP_EPHEMERAL) {
    throw new StreamError('bad-wrap-kind', String(wrap.kind));
  }
  if (wrap.pubkey !== address) {
    throw new StreamError('wrong-stream');
  }
  if (verifyWrapSig && !verifyEvent(wrap)) {
    throw new StreamError('bad-wrap-signature');
  }

  const seal = parseJson<Event>(openNip44(convKey, wrap.content), 'seal');
  let sealForm: SealForm;
  if (seal.kind === KIND_SEAL_ENCRYPTED) {
    sealForm = 'encrypted';
  } else if (seal.kind === KIND_SEAL_PLAINTEXT) {
    sealForm = 'plaintext';
  } else {
    throw new StreamError('bad-seal-kind', String(seal.kind));
  }
  // verifyEvent checks both the id and the Schnorr signature.
  if (!verifyEvent({ ...seal })) {
    throw new StreamError('bad-seal-signature');
  }

  const rumorJson = sealForm === 'plaintext' ? seal.content : openNip44(convKey, seal.content);
  const parsed = parseJson<unknown>(rumorJson, 'rumor');
  if (!isRumorShape(parsed)) {
    throw new StreamError('parse', 'rumor is not an event');
  }
  if (parsed.pubkey !== seal.pubkey) {
    throw new StreamError('author-mismatch');
  }

  const fields = {
    pubkey: parsed.pubkey,
    created_at: parsed.created_at,
    kind: parsed.kind,
    tags: parsed.tags,
    content: parsed.content,
  };
  const computed = getEventHash(fields);
  if (parsed.id !== undefined && parsed.id !== computed) {
    throw new StreamError('bad-rumor-id');
  }
  const rumor: Rumor = { ...fields, id: computed };

  return {
    rumor,
    author: seal.pubkey,
    sealForm,
    seal,
    wrapperId: wrap.id,
    atMs: resolveMsStrict(rumor),
  };
}

/** {@link openWrapAt} for an ordinary plane, addressed by its own group key. */
export function openWrap(wrap: Event, group: GroupKey): OpenedStream {
  return openWrapAt(wrap, group.pk, group.convKey, false);
}

/**
 * Value of the tag `name`, requiring it to appear at most once: any keyholder
 * can craft a rumor, and a duplicated binding tag makes first-match
 * nondeterministic.
 */
export function uniqueTag(rumor: Rumor, name: string): string[] | undefined {
  let found: string[] | undefined;
  for (const tag of rumor.tags) {
    if (tag[0] === name && tag.length >= 2) {
      if (found) {
        throw new StreamError('duplicate-tag', name);
      }
      found = tag;
    }
  }
  return found;
}

/** The chat binding tags: `["channel", id]` + `["epoch", n]`. */
export function channelBindingTags(channelId: string, epoch: number): string[][] {
  return [
    ['channel', channelId],
    ['epoch', String(epoch)],
  ];
}

/**
 * Enforce the chat binding (CORD-03 §3): the rumor must commit the exact
 * channel and epoch whose key decrypted it, or it is a splice and is dropped.
 */
export function checkChannelBinding(rumor: Rumor, channelId: string, epoch: number): void {
  const channel = uniqueTag(rumor, 'channel');
  if (!channel) throw new StreamError('missing-tag', 'channel');
  if (channel[1] !== channelId) throw new StreamError('channel-mismatch');

  const epochTag = uniqueTag(rumor, 'epoch');
  if (!epochTag) throw new StreamError('missing-tag', 'epoch');
  if (epochTag[1] !== String(epoch)) throw new StreamError('epoch-mismatch');
}
