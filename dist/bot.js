import { promises as fs } from 'fs';
import path from 'path';
import mime from 'mime-types';
import { fileTypeFromBuffer } from 'file-type';
import { finalizeEvent } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import { buildClient } from './client.js';
import { createMetadata } from './metadata.js';
import { calculateFileHash, decryptData, encryptData, generateEncryptionParams, } from './crypto.js';
import { getServerConfig, uploadDataWithProgress } from './upload.js';
import { normalizePublicKey } from './keys.js';
import { expirationTagsOf, rewrapRumor, wrapEventWithRumor } from './giftwrap.js';
import { APPLICATION_SPECIFIC, DELETION, ENCRYPTED_DIRECT_MESSAGE, FILE_ATTACHMENT, MESSAGE_EDIT, PRIVATE_DIRECT_MESSAGE, REACTION, } from './kinds.js';
export class AttachmentFile {
    constructor(bytes, extension, imgMeta, filename) {
        this.bytes = bytes;
        this.extension = extension;
        this.imgMeta = imgMeta;
        this.filename = filename;
    }
    static async fromPath(filePath) {
        const bytes = await fs.readFile(filePath);
        const file = await AttachmentFile.fromBytes(bytes);
        file.filename = path.basename(filePath);
        return file;
    }
    static async fromBytes(bytes, extension, filename) {
        const resolvedExtension = extension ?? (await inferExtensionFromBytes(bytes));
        return new AttachmentFile(bytes, resolvedExtension, undefined, filename);
    }
}
export async function loadFile(filePath) {
    return AttachmentFile.fromPath(filePath);
}
async function inferExtensionFromBytes(bytes) {
    const fileType = await fileTypeFromBuffer(bytes);
    return fileType?.ext ?? 'bin';
}
export function createProgressCallback() {
    return (percentage) => {
        if (percentage !== null) {
            console.log(`Upload progress: ${percentage}%`);
        }
    };
}
function sanitizeUrl(candidate, fallback) {
    try {
        return new URL(candidate).toString();
    }
    catch (error) {
        console.error('Invalid URL provided, falling back', error);
        return fallback;
    }
}
/** The `ms` sub-second tag Vector stamps on every rumor for ordering. */
function millisecondTag() {
    return ['ms', (Date.now() % 1000).toString()];
}
/** NIP-30 `["emoji", shortcode, url]` tags. */
function emojiTags(emoji) {
    return (emoji ?? []).map(([shortcode, url]) => ['emoji', shortcode, url]);
}
/**
 * Read a kind-15 file rumor's tags into an {@link ReceivedAttachment}.
 *
 * Returns `null` when the event is not a file attachment.
 */
export function parseAttachment(event) {
    if (event.kind !== FILE_ATTACHMENT || !event.content) {
        return null;
    }
    const tag = (name) => event.tags.find((candidate) => candidate[0] === name)?.[1];
    const key = tag('decryption-key');
    const nonce = tag('decryption-nonce');
    const size = tag('size');
    const dim = tag('dim');
    const thumbhash = tag('thumbhash');
    let imgMeta;
    if (thumbhash && dim) {
        const [width, height] = dim.split('x').map((value) => Number.parseInt(value, 10));
        if (Number.isFinite(width) && Number.isFinite(height)) {
            imgMeta = { thumbhash, width, height };
        }
    }
    return {
        url: event.content,
        mimeType: tag('file-type'),
        size: size ? Number.parseInt(size, 10) : undefined,
        encryption: key && nonce ? { key, nonce } : undefined,
        hash: tag('ox'),
        filename: tag('name'),
        imgMeta,
    };
}
export class VectorBot {
    constructor(privateKey, name, displayName, about, picture, banner, nip05, lud16, client) {
        this.name = name;
        this.displayName = displayName;
        this.about = about;
        this.picture = picture;
        this.banner = banner;
        this.nip05 = nip05;
        this.lud16 = lud16;
        this.privateKey = privateKey;
        this.privateKeyBytes = client.privateKeyBytes;
        this.publicKey = client.publicKey;
        this.client = client;
    }
    static async quick(privateKey) {
        return VectorBot.new(privateKey, 'vector bot', 'Vector Bot', 'vector bot created with quick', 'https://example.com/avatar.png', 'https://example.com/banner.png', 'example@example.com', 'example@example.com');
    }
    static async new(privateKey, name, displayName, about, picture, banner, nip05, lud16, clientConfig) {
        const resolvedPicture = sanitizeUrl(picture, 'https://example.com/avatar.png');
        const resolvedBanner = sanitizeUrl(banner, 'https://example.com/banner.png');
        const client = buildClient(privateKey, clientConfig);
        const metadata = createMetadata(name, displayName, about, resolvedPicture, resolvedBanner, nip05, lud16);
        try {
            await client.setMetadata(metadata);
        }
        catch (error) {
            console.error('Failed to set metadata', error);
        }
        // Advertise where this bot wants its gift wraps delivered, so other clients
        // can route to it instead of guessing at its relay set.
        try {
            await client.publishInboxRelayList();
        }
        catch (error) {
            console.error('Failed to publish inbox relay list', error);
        }
        return new VectorBot(client.privateKey, name, displayName, about, resolvedPicture, resolvedBanner, nip05, lud16, client);
    }
    getChat(recipient) {
        return new Channel(recipient, this);
    }
    /** Alias for {@link getChat}, matching the Rust SDK's `bot.dm(npub)`. */
    dm(recipient) {
        return this.getChat(recipient);
    }
    /** Download a received attachment and decrypt it if it carries a key. */
    async downloadAttachment(attachment) {
        const response = await fetch(attachment.url);
        if (!response.ok) {
            throw new Error(`Failed to download attachment (${response.status})`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!attachment.encryption) {
            return bytes;
        }
        return decryptData(bytes, attachment.encryption);
    }
    /** Download a received attachment and write it to `destination`. */
    async saveAttachment(attachment, destination) {
        const bytes = await this.downloadAttachment(attachment);
        await fs.writeFile(destination, bytes);
        return destination;
    }
}
export class Channel {
    constructor(recipient, baseBot) {
        this.recipient = normalizePublicKey(recipient);
        this.baseBot = baseBot;
    }
    /**
     * Gift-wrap `rumor` to the recipient and publish it to that recipient's inbox
     * relays, then re-wrap the same rumor to the bot itself for multi-device
     * visibility.
     *
     * The self-wrap is best-effort and deliberately not awaited for success: it
     * is a convenience for the sender's other devices, and failing it should
     * never turn a delivered message into a reported failure.
     */
    async deliver(rumorTemplate) {
        const wrapExtras = expirationTagsOf(rumorTemplate.tags ?? []);
        const { wrap, rumor } = wrapEventWithRumor(rumorTemplate, this.baseBot.privateKeyBytes, this.recipient, wrapExtras);
        let sent = false;
        try {
            await this.baseBot.client.publishGiftWrap(wrap, this.recipient);
            sent = true;
        }
        catch (error) {
            console.error('Failed to publish gift-wrap', error);
        }
        if (this.baseBot.client.selfWrap) {
            try {
                const selfWrap = rewrapRumor(rumor, this.baseBot.privateKeyBytes, this.baseBot.publicKey, wrapExtras);
                await this.baseBot.client.publishGiftWrap(selfWrap, this.baseBot.publicKey);
            }
            catch (error) {
                console.error('Failed to publish self gift-wrap', error);
            }
        }
        return { id: rumor.id, sent };
    }
    /**
     * Send a text message. Returns the message id, which is what a later reply,
     * edit, reaction or deletion references.
     */
    async send(content, options = {}) {
        const tags = [['p', this.recipient]];
        if (options.replyTo) {
            tags.push(['e', options.replyTo, '', 'reply']);
        }
        tags.push(millisecondTag());
        tags.push(...emojiTags(options.emoji));
        if (options.expiration) {
            tags.push(['expiration', Math.floor(options.expiration).toString()]);
        }
        tags.push(...(options.extraTags ?? []));
        const result = await this.deliver({
            kind: PRIVATE_DIRECT_MESSAGE,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content,
        });
        if (this.baseBot.client.legacyNip04) {
            await this.sendLegacyNip04(content, options);
        }
        return result;
    }
    /**
     * Gift-wrap and send a rumor you built yourself.
     *
     * The escape hatch for event kinds this class has no method for — a community
     * invite bundle, say. The rumor goes out over the same NIP-17 path as a
     * message, so `p`-tagging, inbox-relay routing and the self-wrap all apply.
     */
    async sendRumor(rumor) {
        const tags = rumor.tags ?? [];
        // Every rumor names its recipient, so a caller that built tags without a
        // `p` tag still produces a deliverable event.
        const hasRecipient = tags.some((tag) => tag[0] === 'p' && tag[1] === this.recipient);
        return this.deliver({
            kind: rumor.kind,
            created_at: rumor.created_at ?? Math.floor(Date.now() / 1000),
            tags: hasRecipient ? tags : [['p', this.recipient], ...tags],
            content: rumor.content,
        });
    }
    /** Send a threaded reply to `messageId`. */
    async reply(messageId, content, options = {}) {
        return this.send(content, { ...options, replyTo: messageId });
    }
    /**
     * Edit a message the bot sent. `messageId` is the id {@link send} returned.
     *
     * An edit is its own event (kind 16) referencing the original, not a rewrite
     * of it — the same event-sourced model Vector uses internally.
     */
    async edit(messageId, newContent, options = {}) {
        return this.deliver({
            kind: MESSAGE_EDIT,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', messageId], ...emojiTags(options.emoji)],
            content: newContent,
        });
    }
    /**
     * Delete a message the bot sent (NIP-09).
     *
     * The deletion request is published openly, since a relay has to read it to
     * act on it. That makes the *request* public, not the message: the original
     * stays sealed inside its gift wrap either way.
     */
    async delete(messageId, reason = '') {
        try {
            const event = finalizeEvent({
                kind: DELETION,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['e', messageId]],
                content: reason,
            }, this.baseBot.privateKeyBytes);
            await this.baseBot.client.publishEvent(event);
            return true;
        }
        catch (error) {
            console.error('Failed to send deletion request', error);
            return false;
        }
    }
    /**
     * React to `messageId`.
     *
     * For a custom emoji, pass the content as `:shortcode:` and the image URL as
     * `emojiUrl`; the pair rides along as a NIP-30 `emoji` tag so a recipient
     * without the pack still renders it.
     */
    async react(messageId, emoji, options = {}) {
        const tags = [
            ['e', messageId],
            ['p', this.recipient],
            ['k', PRIVATE_DIRECT_MESSAGE.toString()],
            millisecondTag(),
        ];
        // Only a genuine `:shortcode:` with a URL earns the custom-emoji tag.
        const isShortcode = emoji.startsWith(':') && emoji.endsWith(':') && emoji.length > 2;
        if (options.emojiUrl && isShortcode) {
            tags.push(['emoji', emoji.slice(1, -1), options.emojiUrl]);
        }
        return this.deliver({
            kind: REACTION,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: emoji,
        });
    }
    /** Show a typing indicator. Expires after 30 seconds. */
    async typing() {
        const now = Math.floor(Date.now() / 1000);
        const expiry = (now + 30).toString();
        const result = await this.deliver({
            kind: APPLICATION_SPECIFIC,
            created_at: now,
            tags: [
                ['p', this.recipient],
                ['d', 'vector'],
                millisecondTag(),
                ['expiration', expiry],
            ],
            content: 'typing',
        });
        return result.sent;
    }
    /**
     * Encrypt, upload and send a file.
     *
     * The kind-15 attachment travels as a gift-wrapped rumor, exactly like a text
     * message — a plain signed kind 15 is not something Vector reads.
     */
    async sendFile(file, options = {}) {
        if (!file) {
            throw new Error('No file provided for sendFile');
        }
        const rawMimeType = mime.lookup(file.extension);
        const mimeType = typeof rawMimeType === 'string' ? rawMimeType : 'application/octet-stream';
        const params = generateEncryptionParams();
        const encrypted = encryptData(file.bytes, params);
        // `ox` is the hash of the original file, not the ciphertext: it is what lets
        // a recipient confirm the decrypted bytes are the ones that were sent.
        const fileHash = calculateFileHash(file.bytes);
        const serverConfig = await getServerConfig();
        const progressCallback = options.progress ?? createProgressCallback();
        const url = await uploadDataWithProgress(this.baseBot.privateKey, serverConfig, encrypted, mimeType, undefined, progressCallback);
        const tags = [
            ['p', this.recipient],
            ['file-type', mimeType],
            ['size', encrypted.length.toString()],
            ['encryption-algorithm', 'aes-gcm'],
            ['decryption-key', params.key],
            ['decryption-nonce', params.nonce],
            ['ox', fileHash],
        ];
        if (options.replyTo) {
            tags.push(['e', options.replyTo, '', 'reply']);
        }
        if (file.filename) {
            tags.push(['name', file.filename]);
        }
        if (file.imgMeta) {
            tags.push(['thumbhash', file.imgMeta.thumbhash]);
            tags.push(['dim', `${file.imgMeta.width}x${file.imgMeta.height}`]);
        }
        tags.push(millisecondTag());
        if (options.expiration) {
            tags.push(['expiration', Math.floor(options.expiration).toString()]);
        }
        tags.push(...(options.extraTags ?? []));
        return this.deliver({
            kind: FILE_ATTACHMENT,
            created_at: Math.floor(Date.now() / 1000),
            tags,
            content: url,
        });
    }
    async sendLegacyNip04(content, options) {
        try {
            const payload = await nip04.encrypt(this.baseBot.privateKey, this.recipient, content);
            const tags = [['p', this.recipient], millisecondTag()];
            if (options.replyTo) {
                tags.push(['e', options.replyTo, '', 'reply']);
            }
            const event = finalizeEvent({
                kind: ENCRYPTED_DIRECT_MESSAGE,
                created_at: Math.floor(Date.now() / 1000),
                tags,
                content: payload,
            }, this.baseBot.privateKeyBytes);
            await this.baseBot.client.publishEvent(event);
        }
        catch (error) {
            console.error('Failed to send NIP-04 private message', error);
        }
    }
    // ── Backwards-compatible wrappers ──────────────────────────────────────────
    /** @deprecated Use {@link send}, which returns the message id. */
    async sendPrivateMessage(message) {
        const result = await this.send(message);
        return result.sent;
    }
    /** @deprecated Use {@link react}. */
    async sendReaction(referenceId, emoji) {
        const result = await this.react(referenceId, emoji);
        return result.sent;
    }
    /** @deprecated Use {@link typing}. */
    async sendTypingIndicator() {
        return this.typing();
    }
    /** @deprecated Use {@link sendFile}, which returns the message id. */
    async sendPrivateFile(file) {
        try {
            const result = await this.sendFile(file);
            return result.sent;
        }
        catch (error) {
            console.error('Failed to send private file', error);
            return false;
        }
    }
}
