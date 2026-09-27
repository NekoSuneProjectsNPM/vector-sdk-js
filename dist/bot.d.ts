import { ClientConfig, VectorClient } from './client.js';
import { EncryptionParams } from './crypto.js';
import { ProgressCallback } from './upload.js';
/**
 * Image metadata carried alongside an attachment.
 *
 * `thumbhash` is a base91-encoded ThumbHash. Vector moved from BlurHash to
 * ThumbHash, and a client reading a `blurhash` tag is no longer part of the
 * protocol.
 */
export interface ImageMetadata {
    thumbhash: string;
    width: number;
    height: number;
}
/** Options shared by every outgoing message. */
export interface SendOptions {
    /** Message id this is a threaded reply to. */
    replyTo?: string;
    /**
     * NIP-40 self-destruct: a Unix timestamp in seconds after which compliant
     * relays and clients drop the message. Stamped on the rumor and mirrored onto
     * the outer wrap, so relays purge the envelope on schedule too.
     */
    expiration?: number;
    /**
     * NIP-30 custom emoji used in the content, as `[shortcode, imageUrl]` pairs.
     * A recipient without the pack subscribed still renders them.
     */
    emoji?: Array<[string, string]>;
    /** Extra bot-routing tags, e.g. from `botTag(...)`. */
    extraTags?: string[][];
}
/** What a send returns: the durable message id, and whether it reached a relay. */
export interface SendResult {
    /** The rumor id — what a reply, edit, reaction or deletion references. */
    id: string;
    sent: boolean;
}
export declare class AttachmentFile {
    bytes: Buffer;
    extension: string;
    imgMeta?: ImageMetadata | undefined;
    filename?: string | undefined;
    constructor(bytes: Buffer, extension: string, imgMeta?: ImageMetadata | undefined, filename?: string | undefined);
    static fromPath(filePath: string): Promise<AttachmentFile>;
    static fromBytes(bytes: Buffer, extension?: string, filename?: string): Promise<AttachmentFile>;
}
export declare function loadFile(filePath: string): Promise<AttachmentFile>;
export declare function createProgressCallback(): ProgressCallback;
/** A received attachment, as described by a kind-15 rumor's tags. */
export interface ReceivedAttachment {
    url: string;
    mimeType?: string;
    size?: number;
    /** Present when the attachment is encrypted, which is Vector's default. */
    encryption?: EncryptionParams;
    /** SHA-256 of the *plaintext* file, from the `ox` tag. */
    hash?: string;
    filename?: string;
    imgMeta?: ImageMetadata;
}
/**
 * Read a kind-15 file rumor's tags into an {@link ReceivedAttachment}.
 *
 * Returns `null` when the event is not a file attachment.
 */
export declare function parseAttachment(event: {
    kind: number;
    content: string;
    tags: string[][];
}): ReceivedAttachment | null;
export declare class VectorBot {
    name: string;
    displayName: string;
    about: string;
    picture: string;
    banner: string;
    nip05: string;
    lud16: string;
    readonly publicKey: string;
    readonly privateKey: string;
    readonly privateKeyBytes: Uint8Array;
    readonly client: VectorClient;
    private constructor();
    static quick(privateKey: string): Promise<VectorBot>;
    static new(privateKey: string, name: string, displayName: string, about: string, picture: string, banner: string, nip05: string, lud16: string, clientConfig?: ClientConfig): Promise<VectorBot>;
    getChat(recipient: string): Channel;
    /** Alias for {@link getChat}, matching the Rust SDK's `bot.dm(npub)`. */
    dm(recipient: string): Channel;
    /** Download a received attachment and decrypt it if it carries a key. */
    downloadAttachment(attachment: ReceivedAttachment): Promise<Buffer>;
    /** Download a received attachment and write it to `destination`. */
    saveAttachment(attachment: ReceivedAttachment, destination: string): Promise<string>;
}
export declare class Channel {
    readonly recipient: string;
    readonly baseBot: VectorBot;
    constructor(recipient: string, baseBot: VectorBot);
    /**
     * Gift-wrap `rumor` to the recipient and publish it to that recipient's inbox
     * relays, then re-wrap the same rumor to the bot itself for multi-device
     * visibility.
     *
     * The self-wrap is best-effort and deliberately not awaited for success: it
     * is a convenience for the sender's other devices, and failing it should
     * never turn a delivered message into a reported failure.
     */
    private deliver;
    /**
     * Send a text message. Returns the message id, which is what a later reply,
     * edit, reaction or deletion references.
     */
    send(content: string, options?: SendOptions): Promise<SendResult>;
    /**
     * Gift-wrap and send a rumor you built yourself.
     *
     * The escape hatch for event kinds this class has no method for — a community
     * invite bundle, say. The rumor goes out over the same NIP-17 path as a
     * message, so `p`-tagging, inbox-relay routing and the self-wrap all apply.
     */
    sendRumor(rumor: {
        kind: number;
        created_at?: number;
        tags?: string[][];
        content: string;
    }): Promise<SendResult>;
    /** Send a threaded reply to `messageId`. */
    reply(messageId: string, content: string, options?: SendOptions): Promise<SendResult>;
    /**
     * Edit a message the bot sent. `messageId` is the id {@link send} returned.
     *
     * An edit is its own event (kind 16) referencing the original, not a rewrite
     * of it — the same event-sourced model Vector uses internally.
     */
    edit(messageId: string, newContent: string, options?: Pick<SendOptions, 'emoji'>): Promise<SendResult>;
    /**
     * Delete a message the bot sent (NIP-09).
     *
     * The deletion request is published openly, since a relay has to read it to
     * act on it. That makes the *request* public, not the message: the original
     * stays sealed inside its gift wrap either way.
     */
    delete(messageId: string, reason?: string): Promise<boolean>;
    /**
     * React to `messageId`.
     *
     * For a custom emoji, pass the content as `:shortcode:` and the image URL as
     * `emojiUrl`; the pair rides along as a NIP-30 `emoji` tag so a recipient
     * without the pack still renders it.
     */
    react(messageId: string, emoji: string, options?: {
        emojiUrl?: string;
    }): Promise<SendResult>;
    /** Show a typing indicator. Expires after 30 seconds. */
    typing(): Promise<boolean>;
    /**
     * Encrypt, upload and send a file.
     *
     * The kind-15 attachment travels as a gift-wrapped rumor, exactly like a text
     * message — a plain signed kind 15 is not something Vector reads.
     */
    sendFile(file?: AttachmentFile, options?: SendOptions & {
        progress?: ProgressCallback;
    }): Promise<SendResult>;
    private sendLegacyNip04;
    /** @deprecated Use {@link send}, which returns the message id. */
    sendPrivateMessage(message: string): Promise<boolean>;
    /** @deprecated Use {@link react}. */
    sendReaction(referenceId: string, emoji: string): Promise<boolean>;
    /** @deprecated Use {@link typing}. */
    sendTypingIndicator(): Promise<boolean>;
    /** @deprecated Use {@link sendFile}, which returns the message id. */
    sendPrivateFile(file?: AttachmentFile): Promise<boolean>;
}
