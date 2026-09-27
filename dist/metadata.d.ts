export interface Metadata {
    name: string;
    displayName: string;
    about: string;
    picture?: string;
    banner?: string;
    nip05?: string;
    lud16?: string;
    website?: string;
    /**
     * Whether the account is a bot.
     *
     * Vector only updates its badge when this field is **present**: a profile
     * that omits it leaves whatever the flag already was. So clearing a badge
     * means publishing `bot: false` explicitly — dropping the field does nothing.
     */
    bot?: boolean;
}
export interface MetadataConfigFields {
    name: string;
    displayName: string;
    about: string;
    picture?: string;
    banner?: string;
    nip05?: string;
    lud16?: string;
}
export declare class MetadataConfig {
    name: string;
    displayName: string;
    about: string;
    picture?: string | undefined;
    banner?: string | undefined;
    nip05?: string | undefined;
    lud16?: string | undefined;
    constructor(name: string, displayName: string, about: string, picture?: string | undefined, banner?: string | undefined, nip05?: string | undefined, lud16?: string | undefined);
    build(bot?: boolean): Metadata;
}
export declare class MetadataConfigBuilder {
    private config;
    name(value: string): this;
    displayName(value: string): this;
    about(value: string): this;
    picture(value: string): this;
    banner(value: string): this;
    nip05(value: string): this;
    lud16(value: string): this;
    build(): Metadata;
}
export declare function createMetadata(name: string, displayName: string, about: string, picture?: string, banner?: string, nip05?: string, lud16?: string, bot?: boolean): Metadata;
/**
 * Serialize metadata to kind-0 content, dropping empty fields.
 *
 * `bot` survives even when false — it is the only way to clear a badge, so
 * treating `false` as "nothing to say" would make the badge unclearable.
 */
export declare function metadataToContent(metadata: Metadata): string;
