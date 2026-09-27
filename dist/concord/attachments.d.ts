import type { EncryptionParams } from '../crypto.js';
import type { Rumor } from './stream.js';
/** A bounded message can still carry ~1700 imeta tags; cap the amplification. */
export declare const MAX_ATTACHMENTS_PER_MESSAGE = 32;
/** Default download cap. Override per call. */
export declare const DEFAULT_MAX_ATTACHMENT_BYTES: number;
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
/** Keep a sender-supplied filename to one harmless path segment. */
export declare function sanitizeFilename(name: string): string;
/**
 * Parse one `imeta` tag. Returns undefined for anything that isn't an imeta,
 * has no url, specifies only half of the key/nonce pair, or carries a
 * non-hex nonce.
 */
export declare function attachmentFromImeta(tag: string[]): CommunityAttachment | undefined;
/** Every attachment on a rumor, in tag order, capped. */
export declare function attachmentsFromRumor(rumor: Pick<Rumor, 'tags'>): CommunityAttachment[];
/**
 * Remove attachment blob URLs some clients (Armada) also inline into the
 * caption; the imeta is the real attachment, and the raw link is an
 * undecryptable blob to anyone reading the text.
 */
export declare function stripAttachmentUrls(content: string, attachments: CommunityAttachment[]): string;
/** A sensible filename for a downloaded attachment. */
export declare function attachmentFilename(attachment: CommunityAttachment, index?: number): string;
/**
 * Download and decrypt an attachment, trying its mirrors in turn.
 *
 * Refuses anything over `maxBytes` (checked against the declared size first,
 * then the real one), and, when the sender stamped a plaintext hash, verifies
 * the decrypted bytes against it.
 */
export declare function downloadCommunityAttachment(attachment: CommunityAttachment, options?: {
    maxBytes?: number;
    fetchImpl?: typeof fetch;
}): Promise<Buffer>;
