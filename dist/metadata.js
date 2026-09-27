export class MetadataConfig {
    constructor(name, displayName, about, picture, banner, nip05, lud16) {
        this.name = name;
        this.displayName = displayName;
        this.about = about;
        this.picture = picture;
        this.banner = banner;
        this.nip05 = nip05;
        this.lud16 = lud16;
    }
    build(bot = true) {
        return {
            name: this.name,
            displayName: this.displayName,
            about: this.about,
            picture: this.picture,
            banner: this.banner,
            nip05: this.nip05,
            lud16: this.lud16,
            bot,
        };
    }
}
export class MetadataConfigBuilder {
    constructor() {
        this.config = {
            name: '',
            displayName: '',
            about: '',
        };
    }
    name(value) {
        this.config.name = value;
        return this;
    }
    displayName(value) {
        this.config.displayName = value;
        return this;
    }
    about(value) {
        this.config.about = value;
        return this;
    }
    picture(value) {
        this.config.picture = value;
        return this;
    }
    banner(value) {
        this.config.banner = value;
        return this;
    }
    nip05(value) {
        this.config.nip05 = value;
        return this;
    }
    lud16(value) {
        this.config.lud16 = value;
        return this;
    }
    build() {
        return new MetadataConfig(this.config.name, this.config.displayName, this.config.about, this.config.picture, this.config.banner, this.config.nip05, this.config.lud16).build();
    }
}
export function createMetadata(name, displayName, about, picture, banner, nip05, lud16, bot = true) {
    return new MetadataConfig(name, displayName, about, picture, banner, nip05, lud16).build(bot);
}
/**
 * Serialize metadata to kind-0 content, dropping empty fields.
 *
 * `bot` survives even when false — it is the only way to clear a badge, so
 * treating `false` as "nothing to say" would make the badge unclearable.
 */
export function metadataToContent(metadata) {
    const out = {};
    const put = (key, value) => {
        if (value !== undefined && value !== '') {
            out[key] = value;
        }
    };
    put('name', metadata.name);
    // Clients have written both spellings for years; emit the NIP-01 one and
    // keep the camelCase alias so older readers still see a display name.
    put('display_name', metadata.displayName);
    put('displayName', metadata.displayName);
    put('about', metadata.about);
    put('picture', metadata.picture);
    put('banner', metadata.banner);
    put('nip05', metadata.nip05);
    put('lud16', metadata.lud16);
    put('website', metadata.website);
    if (metadata.bot !== undefined) {
        out.bot = metadata.bot;
    }
    return JSON.stringify(out);
}
