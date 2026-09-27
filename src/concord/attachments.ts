/**
 * Community message attachments (NIP-92 `imeta`).
 *
 * A port of `vector-core/src/community/attachments.rs`. A community message
 * carries its caption in `content` plus one `imeta` tag per file, so one
 * message can mix text and several files. Each tag holds that file's own
 * AES-256-GCM key and nonce; the Blossom server only ever sees ciphertext,
 * which only members who can open the message can decrypt.
 *
 * Entries are `key value` strings; only the first space delimits, so a value
 * (a filename) may contain spaces.
 */
import { calculateFileHash, decryptData } from '../crypto.js';
import type { EncryptionParams } from '../crypto.js';
import type { Rumor } from './stream.js';

/** A bounded message can still carry ~1700 imeta tags; cap the amplification. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 32;

/** Default download cap. Override per call. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface CommunityAttachment {
  url: string;
  /** Mirrors of the same ciphertext (https only), tried when `url` fails. */
  fallbackUrls: string[];
  mimeType: string;
  /** Sanitized filename, when the sender gave one. */
  name?: string;
  /** Ciphertext size in bytes, as declared by the sender. */
  size?: number;
  /** Absent for plain (foreign NIP-92) media, which downloads as-is. */
  encryption?: EncryptionParams;
  /** SHA-256 of the plaintext (`ox`, or NIP-92 `x`), checked after download. */
  hash?: string;
  width?: number;
  height?: number;
}

function field(entries: string[], key: string): string | undefined {
  for (const entry of entries) {
    if (entry.startsWith(`${key} `)) {
      return entry.slice(key.length + 1);
    }
  }
  return undefined;
}

function fieldsAll(entries: string[], key: string): string[] {
  return entries.filter((entry) => entry.startsWith(`${key} `)).map((entry) => entry.slice(key.length + 1));
}

/** Keep a sender-supplied filename to one harmless path segment. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
}

/**
 * Parse one `imeta` tag. Returns undefined for anything that isn't an imeta,
 * has no url, specifies only half of the key/nonce pair, or carries a
 * non-hex nonce.
 */
export function attachmentFromImeta(tag: string[]): CommunityAttachment | undefined {
  if (tag[0] !== 'imeta') {
    return undefined;
  }
  const body = tag.slice(1);

  const url = field(body, 'url');
  if (!url) {
    return undefined;
  }

  const key = field(body, 'decryption-key') ?? '';
  const nonce = field(body, 'decryption-nonce') ?? '';
  if (!key !== !nonce) {
    return undefined; // half-specified encryption is malformed
  }
  const encrypted = key !== '';
  if (encrypted && (nonce.length > 128 || !/^[0-9a-f]+$/i.test(nonce) || !/^[0-9a-f]+$/i.test(key))) {
    return undefined;
  }

  const size = Number(field(body, 'size'));
  const hash = field(body, 'ox') ?? field(body, 'x');
  const dim = field(body, 'dim')?.match(/^(\d+)x(\d+)$/);
  const name = field(body, 'name');

  const fallbackUrls: string[] = [];
  for (const mirror of fieldsAll(body, 'fallback')) {
    if (!mirror.startsWith('https://') || /\s/.test(mirror) || mirror === url || fallbackUrls.includes(mirror)) {
      continue;
    }
    fallbackUrls.push(mirror);
    if (fallbackUrls.length >= 4) break;
  }

  return {
    url,
    fallbackUrls,
    mimeType: field(body, 'm') || 'application/octet-stream',
    name: name ? sanitizeFilename(name) || undefined : undefined,
    size: Number.isFinite(size) && size > 0 ? size : undefined,
    encryption: encrypted ? { key, nonce } : undefined,
    hash: hash && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : undefined,
    width: dim ? Number(dim[1]) : undefined,
    height: dim ? Number(dim[2]) : undefined,
  };
}

/** Every attachment on a rumor, in tag order, capped. */
export function attachmentsFromRumor(rumor: Pick<Rumor, 'tags'>): CommunityAttachment[] {
  const out: CommunityAttachment[] = [];
  for (const tag of rumor.tags) {
    const attachment = attachmentFromImeta(tag);
    if (attachment) {
      out.push(attachment);
      if (out.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    }
  }
  return out;
}

/**
 * Remove attachment blob URLs some clients (Armada) also inline into the
 * caption; the imeta is the real attachment, and the raw link is an
 * undecryptable blob to anyone reading the text.
 */
export function stripAttachmentUrls(content: string, attachments: CommunityAttachment[]): string {
  if (!content || !attachments.length) {
    return content;
  }
  let out = content;
  for (const attachment of attachments) {
    out = out.split(attachment.url).join('');
  }
  if (out === content) {
    return content;
  }
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** A sensible filename for a downloaded attachment. */
export function attachmentFilename(attachment: CommunityAttachment, index = 0): string {
  if (attachment.name) {
    return attachment.name;
  }
  const subtype = attachment.mimeType.split('/')[1]?.split(/[+;]/)[0] || 'bin';
  const extension = subtype === 'jpeg' ? 'jpg' : subtype === 'octet-stream' ? 'bin' : subtype;
  return `attachment-${index + 1}.${extension}`;
}

/**
 * Download and decrypt an attachment, trying its mirrors in turn.
 *
 * Refuses anything over `maxBytes` (checked against the declared size first,
 * then the real one), and, when the sender stamped a plaintext hash, verifies
 * the decrypted bytes against it.
 */
export async function downloadCommunityAttachment(
  attachment: CommunityAttachment,
  options: { maxBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (attachment.size !== undefined && attachment.size > maxBytes) {
    throw new Error(`Attachment is ${attachment.size} bytes, over the ${maxBytes}-byte limit`);
  }

  let lastError: unknown;
  for (const url of [attachment.url, ...attachment.fallbackUrls]) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) {
        throw new Error(`Attachment is ${bytes.length} bytes, over the ${maxBytes}-byte limit`);
      }

      const plain = attachment.encryption ? decryptData(bytes, attachment.encryption) : bytes;
      if (attachment.hash && calculateFileHash(plain) !== attachment.hash) {
        throw new Error('Attachment does not match its stated hash');
      }
      return plain;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
