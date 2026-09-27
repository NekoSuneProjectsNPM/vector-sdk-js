import type { Event } from 'nostr-tools';
import type { GroupKey } from './derive.js';
export declare const KIND_WRAP = 1059;
export declare const KIND_WRAP_EPHEMERAL = 21059;
export declare const KIND_SEAL_ENCRYPTED = 20013;
export declare const KIND_SEAL_PLAINTEXT = 20014;
/** NIP-44 v2 plaintext hard cap, enforced at every nesting layer. */
export declare const NIP44_MAX_PLAINTEXT = 65535;
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
export declare class StreamError extends Error {
    readonly code: string;
    constructor(code: string, message?: string);
}
/**
 * A rumor's true millisecond time, strict per CORD-02 §5: no `ms` tag means
 * offset 0; a present `ms` tag that is not a lone 0..=999 decimal without
 * leading zeros makes the event malformed (dropped, never clamped). The first
 * occurrence wins, matching Armada.
 */
export declare function resolveMsStrict(rumor: Pick<Rumor, 'created_at' | 'tags'>): number;
/**
 * An unsigned rumor with a full epoch-ms time: `created_at` takes the seconds,
 * an `["ms", <0..999>]` tag appended last takes the remainder.
 */
export declare function buildRumorMs(kind: number, author: string, content: string, tags: string[][], atMs: number): Rumor;
/** An unsigned rumor with a seconds timestamp and no `ms` tag (control plane shape). */
export declare function buildRumorSecs(kind: number, author: string, content: string, tags: string[][], atSecs: number): Rumor;
/** Seal a rumor with the author's real key. */
export declare function buildSeal(rumor: Rumor, form: SealForm, group: GroupKey, authorSk: Uint8Array): Event;
/**
 * Wrap a signed seal into the outer stream event: NIP-44 under the stream's
 * conversation key, signed by the group key, one random ephemeral `p` tag.
 * `wrapAt` is the untweaked wall clock (CORD-01 forbids NIP-59's tweak here).
 */
export declare function wrapSeal(seal: Event, group: GroupKey, options?: {
    kind?: number;
    wrapAt?: number;
    extraTags?: string[][];
}): Event;
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
export declare function openWrapAt(wrap: Event, address: string, convKey: Uint8Array, verifyWrapSig?: boolean): OpenedStream;
/** {@link openWrapAt} for an ordinary plane, addressed by its own group key. */
export declare function openWrap(wrap: Event, group: GroupKey): OpenedStream;
/**
 * Value of the tag `name`, requiring it to appear at most once: any keyholder
 * can craft a rumor, and a duplicated binding tag makes first-match
 * nondeterministic.
 */
export declare function uniqueTag(rumor: Rumor, name: string): string[] | undefined;
/** The chat binding tags: `["channel", id]` + `["epoch", n]`. */
export declare function channelBindingTags(channelId: string, epoch: number): string[][];
/**
 * Enforce the chat binding (CORD-03 §3): the rumor must commit the exact
 * channel and epoch whose key decrypted it, or it is a splice and is dropped.
 */
export declare function checkChannelBinding(rumor: Rumor, channelId: string, epoch: number): void;
