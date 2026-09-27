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

export class MetadataConfig {
  constructor(
    public name: string,
    public displayName: string,
    public about: string,
    public picture?: string,
    public banner?: string,
    public nip05?: string,
    public lud16?: string,
  ) {}

  public build(bot = true): Metadata {
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
  private config: MetadataConfigFields = {
    name: '',
    displayName: '',
    about: '',
  };

  public name(value: string): this {
    this.config.name = value;
    return this;
  }

  public displayName(value: string): this {
    this.config.displayName = value;
    return this;
  }

  public about(value: string): this {
    this.config.about = value;
    return this;
  }

  public picture(value: string): this {
    this.config.picture = value;
    return this;
  }

  public banner(value: string): this {
    this.config.banner = value;
    return this;
  }

  public nip05(value: string): this {
    this.config.nip05 = value;
    return this;
  }

  public lud16(value: string): this {
    this.config.lud16 = value;
    return this;
  }

  public build(): Metadata {
    return new MetadataConfig(
      this.config.name,
      this.config.displayName,
      this.config.about,
      this.config.picture,
      this.config.banner,
      this.config.nip05,
      this.config.lud16,
    ).build();
  }
}

export function createMetadata(
  name: string,
  displayName: string,
  about: string,
  picture?: string,
  banner?: string,
  nip05?: string,
  lud16?: string,
  bot = true,
): Metadata {
  return new MetadataConfig(name, displayName, about, picture, banner, nip05, lud16).build(bot);
}

/**
 * Serialize metadata to kind-0 content, dropping empty fields.
 *
 * `bot` survives even when false — it is the only way to clear a badge, so
 * treating `false` as "nothing to say" would make the badge unclearable.
 */
export function metadataToContent(metadata: Metadata): string {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: string | undefined) => {
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
