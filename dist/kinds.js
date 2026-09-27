/**
 * Nostr event kinds used by Vector.
 *
 * Mirrors `vector_core::stored_event::event_kind`, plus the standard kinds the
 * DM plane rides on. Kept in one place so a protocol move upstream is a single
 * edit here.
 */
/** Chat message text content. Vector's internal storage kind for every text message. */
export const CHAT_MESSAGE = 9;
/** NIP-25 emoji reaction. */
export const REACTION = 7;
/** NIP-09 deletion request. */
export const DELETION = 5;
/** NIP-02 contact list — who an account follows. Replaceable. */
export const CONTACT_LIST = 3;
/** NIP-04 legacy encrypted DM. Vector no longer sends these; opt-in only. */
export const ENCRYPTED_DIRECT_MESSAGE = 4;
/** NIP-17 private direct message (the gift-wrapped rumor kind). */
export const PRIVATE_DIRECT_MESSAGE = 14;
/** Vector-specific: file attachment with encryption metadata, sent as a rumor. */
export const FILE_ATTACHMENT = 15;
/** Vector-specific: message edit. References the original, carries the new content. */
export const MESSAGE_EDIT = 16;
/** NIP-59 seal. */
export const SEAL = 13;
/** NIP-59 gift wrap. */
export const GIFT_WRAP = 1059;
/** NIP-17 DM relay list — where a pubkey wants its gift wraps delivered. */
export const DM_RELAY_LIST = 10050;
/** NIP-78 application-specific data. Typing indicators and peer ads ride this. */
export const APPLICATION_SPECIFIC = 30078;
/** Bot Interface Manifest: one replaceable command catalog per bot pubkey. */
export const BOT_MANIFEST = 10304;
/**
 * Legacy Vector MLS kinds, used by the `mlsAdapter` sidecar path.
 *
 * Superseded upstream by the Concord v2 append plane below; kept because the
 * sidecar bridge in this package still speaks them.
 */
export const MLS_WELCOME = 443;
export const MLS_GROUP_WRAPPER = 444;
/**
 * Concord v2 community append-plane kinds (Vector-claimed block 3300-3399).
 *
 * One kind per event type so relays can slice by type with a plain `kinds`
 * filter. Exported for identification and filtering — this package does not
 * implement the v2 envelope, epoch keys or consensus folding, all of which
 * live in `vector-core`.
 */
export const COMMUNITY_MESSAGE = 3300;
export const COMMUNITY_REACTION = 3301;
export const COMMUNITY_EDIT = 3302;
export const COMMUNITY_REKEY = 3303;
export const COMMUNITY_INVITE_BUNDLE = 3304;
export const COMMUNITY_DELETE = 3305;
export const COMMUNITY_PRESENCE = 3306;
/** 3307 is RETIRED upstream. Never reuse the number. */
export const COMMUNITY_CONTROL = 3308;
export const COMMUNITY_KICK = 3309;
export const COMMUNITY_WEBXDC = 3310;
export const COMMUNITY_TYPING = 3311;
/** Every Concord v2 kind, in numeric order. */
export const COMMUNITY_KINDS = [
    COMMUNITY_MESSAGE,
    COMMUNITY_REACTION,
    COMMUNITY_EDIT,
    COMMUNITY_REKEY,
    COMMUNITY_INVITE_BUNDLE,
    COMMUNITY_DELETE,
    COMMUNITY_PRESENCE,
    COMMUNITY_CONTROL,
    COMMUNITY_KICK,
    COMMUNITY_WEBXDC,
    COMMUNITY_TYPING,
];
/** True when `kind` belongs to the Concord v2 append plane. */
export function isCommunityKind(kind) {
    return COMMUNITY_KINDS.includes(kind);
}
