/**
 * Nostr event kinds used by Vector.
 *
 * Mirrors `vector_core::stored_event::event_kind`, plus the standard kinds the
 * DM plane rides on. Kept in one place so a protocol move upstream is a single
 * edit here.
 */
/** Chat message text content. Vector's internal storage kind for every text message. */
export declare const CHAT_MESSAGE = 9;
/** NIP-25 emoji reaction. */
export declare const REACTION = 7;
/** NIP-09 deletion request. */
export declare const DELETION = 5;
/** NIP-02 contact list — who an account follows. Replaceable. */
export declare const CONTACT_LIST = 3;
/** NIP-04 legacy encrypted DM. Vector no longer sends these; opt-in only. */
export declare const ENCRYPTED_DIRECT_MESSAGE = 4;
/** NIP-17 private direct message (the gift-wrapped rumor kind). */
export declare const PRIVATE_DIRECT_MESSAGE = 14;
/** Vector-specific: file attachment with encryption metadata, sent as a rumor. */
export declare const FILE_ATTACHMENT = 15;
/** Vector-specific: message edit. References the original, carries the new content. */
export declare const MESSAGE_EDIT = 16;
/** NIP-59 seal. */
export declare const SEAL = 13;
/** NIP-59 gift wrap. */
export declare const GIFT_WRAP = 1059;
/** NIP-17 DM relay list — where a pubkey wants its gift wraps delivered. */
export declare const DM_RELAY_LIST = 10050;
/** NIP-78 application-specific data. Typing indicators and peer ads ride this. */
export declare const APPLICATION_SPECIFIC = 30078;
/** Bot Interface Manifest: one replaceable command catalog per bot pubkey. */
export declare const BOT_MANIFEST = 10304;
/**
 * Legacy Vector MLS kinds, used by the `mlsAdapter` sidecar path.
 *
 * Superseded upstream by the Concord v2 append plane below; kept because the
 * sidecar bridge in this package still speaks them.
 */
export declare const MLS_WELCOME = 443;
export declare const MLS_GROUP_WRAPPER = 444;
/**
 * Concord v2 community append-plane kinds (Vector-claimed block 3300-3399).
 *
 * One kind per event type so relays can slice by type with a plain `kinds`
 * filter. Exported for identification and filtering — this package does not
 * implement the v2 envelope, epoch keys or consensus folding, all of which
 * live in `vector-core`.
 */
export declare const COMMUNITY_MESSAGE = 3300;
export declare const COMMUNITY_REACTION = 3301;
export declare const COMMUNITY_EDIT = 3302;
export declare const COMMUNITY_REKEY = 3303;
export declare const COMMUNITY_INVITE_BUNDLE = 3304;
export declare const COMMUNITY_DELETE = 3305;
export declare const COMMUNITY_PRESENCE = 3306;
/** 3307 is RETIRED upstream. Never reuse the number. */
export declare const COMMUNITY_CONTROL = 3308;
export declare const COMMUNITY_KICK = 3309;
export declare const COMMUNITY_WEBXDC = 3310;
export declare const COMMUNITY_TYPING = 3311;
/** Guestbook snapshot, refounder-signed and chunked. */
export declare const COMMUNITY_SNAPSHOT = 3312;
/**
 * Concord v2 **direct invite**.
 *
 * This is what a current Vector app sends when it invites someone to a
 * community. It rides a standard NIP-59 gift wrap to a person — not the
 * reversed stream wrap the rest of the v2 plane uses — and the wrap carries an
 * outer `["k", "3313"]` index hint.
 *
 * Not to be confused with {@link COMMUNITY_INVITE_BUNDLE} (3304), which is the
 * older v1 bundle. A bot that only watches 3304 sees no invites at all from a
 * modern client.
 */
export declare const COMMUNITY_DIRECT_INVITE = 3313;
/** Threaded reply in a v2 channel (NIP-22 comment). */
export declare const COMMUNITY_COMMENT = 1111;
/** Typing indicator, ephemeral tier. */
export declare const COMMUNITY_TYPING_EPHEMERAL = 23311;
/** Public invite bundle — a bare addressable event, outside the wrap. */
export declare const COMMUNITY_INVITE_BUNDLE_PUBLIC = 33301;
/** Every Concord v2 kind, in numeric order. */
export declare const COMMUNITY_KINDS: readonly number[];
/** True when `kind` belongs to the Concord v2 append plane. */
export declare function isCommunityKind(kind: number): boolean;
