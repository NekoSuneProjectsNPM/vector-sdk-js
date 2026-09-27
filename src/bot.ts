import { promises as fs } from 'fs';
import path from 'path';
import mime from 'mime-types';
import { fileTypeFromBuffer } from 'file-type';
import type { Event, UnsignedEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';

import { buildClient, ClientConfig, VectorClient } from './client.js';
import { createMetadata } from './metadata.js';
import {
  calculateFileHash,
  decryptData,
  encryptData,
  EncryptionParams,
  generateEncryptionParams,
} from './crypto.js';
import { getServerConfig, ProgressCallback, uploadDataWithProgress } from './upload.js';
import { normalizePublicKey } from './keys.js';
import { expirationTagsOf, rewrapRumor, wrapEventWithRumor } from './giftwrap.js';
import {
  APPLICATION_SPECIFIC,
  DELETION,
  ENCRYPTED_DIRECT_MESSAGE,
  FILE_ATTACHMENT,
  MESSAGE_EDIT,
  PRIVATE_DIRECT_MESSAGE,
  REACTION,
} from './kinds.js';

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

export class AttachmentFile {
  constructor(
    public bytes: Buffer,
    public extension: string,
    public imgMeta?: ImageMetadata,
    public filename?: string,
  ) {}

  public static async fromPath(filePath: string): Promise<AttachmentFile> {
    const bytes = await fs.readFile(filePath);
    const file = await AttachmentFile.fromBytes(bytes);
    file.filename = path.basename(filePath);
    return file;
  }

  public static async fromBytes(
    bytes: Buffer,
    extension?: string,
    filename?: string,
  ): Promise<AttachmentFile> {
    const resolvedExtension = extension ?? (await inferExtensionFromBytes(bytes));
    return new AttachmentFile(bytes, resolvedExtension, undefined, filename);
  }
}

export async function loadFile(filePath: string): Promise<AttachmentFile> {
  return AttachmentFile.fromPath(filePath);
}

async function inferExtensionFromBytes(bytes: Buffer): Promise<string> {
  const fileType = await fileTypeFromBuffer(bytes);
  return fileType?.ext ?? 'bin';
}

export function createProgressCallback(): ProgressCallback {
  return (percentage: number | null) => {
    if (percentage !== null) {
      console.log(`Upload progress: ${percentage}%`);
    }
  };
}

function sanitizeUrl(candidate: string, fallback: string): string {
  try {
    return new URL(candidate).toString();
  } catch (error) {
    console.error('Invalid URL provided, falling back', error);
    return fallback;
  }
}

/** The `ms` sub-second tag Vector stamps on every rumor for ordering. */
function millisecondTag(): string[] {
  return ['ms', (Date.now() % 1000).toString()];
}

/** NIP-30 `["emoji", shortcode, url]` tags. */
function emojiTags(emoji?: Array<[string, string]>): string[][] {
  return (emoji ?? []).map(([shortcode, url]) => ['emoji', shortcode, url]);
}

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
export function parseAttachment(event: { kind: number; content: string; tags: string[][] }): ReceivedAttachment | null {
  if (event.kind !== FILE_ATTACHMENT || !event.content) {
    return null;
  }

  const tag = (name: string): string | undefined =>
    event.tags.find((candidate) => candidate[0] === name)?.[1];

  const key = tag('decryption-key');
  const nonce = tag('decryption-nonce');
  const size = tag('size');
  const dim = tag('dim');
  const thumbhash = tag('thumbhash');

  let imgMeta: ImageMetadata | undefined;
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
  public readonly publicKey: string;
  public readonly privateKey: string;
  public readonly privateKeyBytes: Uint8Array;
  public readonly client: VectorClient;

  private constructor(
    privateKey: string,
    public name: string,
    public displayName: string,
    public about: string,
    public picture: string,
    public banner: string,
    public nip05: string,
    public lud16: string,
    client: VectorClient,
  ) {
    this.privateKey = privateKey;
    this.privateKeyBytes = client.privateKeyBytes;
    this.publicKey = client.publicKey;
    this.client = client;
  }

  public static async quick(privateKey: string): Promise<VectorBot> {
    return VectorBot.new(
      privateKey,
      'vector bot',
      'Vector Bot',
      'vector bot created with quick',
      'https://example.com/avatar.png',
      'https://example.com/banner.png',
      'example@example.com',
      'example@example.com',
    );
  }

  public static async new(
    privateKey: string,
    name: string,
    displayName: string,
    about: string,
    picture: string,
    banner: string,
    nip05: string,
    lud16: string,
    clientConfig?: ClientConfig,
    options: { bot?: boolean; publishProfile?: boolean } = {},
  ): Promise<VectorBot> {
    const resolvedPicture = sanitizeUrl(picture, 'https://example.com/avatar.png');
    const resolvedBanner = sanitizeUrl(banner, 'https://example.com/banner.png');

    const client = buildClient(privateKey, clientConfig);
    const metadata = createMetadata(
      name,
      displayName,
      about,
      resolvedPicture,
      resolvedBanner,
      nip05,
      lud16,
      options.bot !== false,
    );

    // Publishing merges over whatever the account already has, rather than
    // replacing it. Kind 0 is replaceable, so a plain publish would erase the
    // name, picture and bio of anyone who ran this with a personal key — and
    // stamp them as a bot, which Vector will not un-badge until something
    // publishes `bot: false`.
    if (options.publishProfile !== false) {
      try {
        await client.setMetadata(metadata);
      } catch (error) {
        console.error('Failed to set metadata', error);
      }
    }

    // Advertise where this bot wants its gift wraps delivered, so other clients
    // can route to it instead of guessing at its relay set.
    try {
      await client.publishInboxRelayList();
    } catch (error) {
      console.error('Failed to publish inbox relay list', error);
    }

    return new VectorBot(
      client.privateKey,
      name,
      displayName,
      about,
      resolvedPicture,
      resolvedBanner,
      nip05,
      lud16,
      client,
    );
  }

  public getChat(recipient: string): Channel {
    return new Channel(recipient, this);
  }

  /** Alias for {@link getChat}, matching the Rust SDK's `bot.dm(npub)`. */
  public dm(recipient: string): Channel {
    return this.getChat(recipient);
  }

  /** Download a received attachment and decrypt it if it carries a key. */
  public async downloadAttachment(attachment: ReceivedAttachment): Promise<Buffer> {
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
  public async saveAttachment(
    attachment: ReceivedAttachment,
    destination: string,
  ): Promise<string> {
    const bytes = await this.downloadAttachment(attachment);
    await fs.writeFile(destination, bytes);
    return destination;
  }
}

export class Channel {
  public readonly recipient: string;
  public readonly baseBot: VectorBot;

  constructor(recipient: string, baseBot: VectorBot) {
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
  private async deliver(
    rumorTemplate: Partial<UnsignedEvent>,
  ): Promise<SendResult> {
    const wrapExtras = expirationTagsOf(rumorTemplate.tags ?? []);
    const { wrap, rumor } = wrapEventWithRumor(
      rumorTemplate,
      this.baseBot.privateKeyBytes,
      this.recipient,
      wrapExtras,
    );

    let sent = false;
    try {
      await this.baseBot.client.publishGiftWrap(wrap, this.recipient);
      sent = true;
    } catch (error) {
      console.error('Failed to publish gift-wrap', error);
    }

    if (this.baseBot.client.selfWrap) {
      try {
        const selfWrap = rewrapRumor(
          rumor,
          this.baseBot.privateKeyBytes,
          this.baseBot.publicKey,
          wrapExtras,
        );
        await this.baseBot.client.publishGiftWrap(selfWrap, this.baseBot.publicKey);
      } catch (error) {
        console.error('Failed to publish self gift-wrap', error);
      }
    }

    return { id: rumor.id, sent };
  }

  /**
   * Send a text message. Returns the message id, which is what a later reply,
   * edit, reaction or deletion references.
   */
  public async send(content: string, options: SendOptions = {}): Promise<SendResult> {
    const tags: string[][] = [['p', this.recipient]];

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
  public async sendRumor(rumor: {
    kind: number;
    created_at?: number;
    tags?: string[][];
    content: string;
  }): Promise<SendResult> {
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
  public async reply(
    messageId: string,
    content: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    return this.send(content, { ...options, replyTo: messageId });
  }

  /**
   * Edit a message the bot sent. `messageId` is the id {@link send} returned.
   *
   * An edit is its own event (kind 16) referencing the original, not a rewrite
   * of it — the same event-sourced model Vector uses internally.
   */
  public async edit(
    messageId: string,
    newContent: string,
    options: Pick<SendOptions, 'emoji'> = {},
  ): Promise<SendResult> {
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
  public async delete(messageId: string, reason = ''): Promise<boolean> {
    try {
      const event = finalizeEvent(
        {
          kind: DELETION,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['e', messageId]],
          content: reason,
        },
        this.baseBot.privateKeyBytes,
      );
      await this.baseBot.client.publishEvent(event);
      return true;
    } catch (error) {
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
  public async react(
    messageId: string,
    emoji: string,
    options: { emojiUrl?: string } = {},
  ): Promise<SendResult> {
    const tags: string[][] = [
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
  public async typing(): Promise<boolean> {
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
  public async sendFile(
    file?: AttachmentFile,
    options: SendOptions & { progress?: ProgressCallback } = {},
  ): Promise<SendResult> {
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
    const url = await uploadDataWithProgress(
      this.baseBot.privateKey,
      serverConfig,
      encrypted,
      mimeType,
      undefined,
      progressCallback,
    );

    const tags: string[][] = [
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

  private async sendLegacyNip04(content: string, options: SendOptions): Promise<void> {
    try {
      const payload = await nip04.encrypt(this.baseBot.privateKey, this.recipient, content);
      const tags: string[][] = [['p', this.recipient], millisecondTag()];
      if (options.replyTo) {
        tags.push(['e', options.replyTo, '', 'reply']);
      }
      const event: Event = finalizeEvent(
        {
          kind: ENCRYPTED_DIRECT_MESSAGE,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: payload,
        },
        this.baseBot.privateKeyBytes,
      );
      await this.baseBot.client.publishEvent(event);
    } catch (error) {
      console.error('Failed to send NIP-04 private message', error);
    }
  }

  // ── Backwards-compatible wrappers ──────────────────────────────────────────

  /** @deprecated Use {@link send}, which returns the message id. */
  public async sendPrivateMessage(message: string): Promise<boolean> {
    const result = await this.send(message);
    return result.sent;
  }

  /** @deprecated Use {@link react}. */
  public async sendReaction(referenceId: string, emoji: string): Promise<boolean> {
    const result = await this.react(referenceId, emoji);
    return result.sent;
  }

  /** @deprecated Use {@link typing}. */
  public async sendTypingIndicator(): Promise<boolean> {
    return this.typing();
  }

  /** @deprecated Use {@link sendFile}, which returns the message id. */
  public async sendPrivateFile(file?: AttachmentFile): Promise<boolean> {
    try {
      const result = await this.sendFile(file);
      return result.sent;
    } catch (error) {
      console.error('Failed to send private file', error);
      return false;
    }
  }
}
