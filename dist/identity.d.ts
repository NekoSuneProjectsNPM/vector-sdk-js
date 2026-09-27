/**
 * Bot accounts: creating one, saving it, and loading it back.
 *
 * A Vector bot *is* a Nostr keypair — there is no signup, no server, and nobody
 * to ask. {@link generateAccount} mints one locally and it exists the moment it
 * is created. {@link loadOrCreateAccount} is the keyless mode the Rust SDK
 * offers: the first run creates an identity, every run after reuses it, so a
 * bot keeps its chats and memberships across restarts.
 *
 * The private key is the account. Anyone holding it *is* the bot: they can read
 * its messages and send as it, and there is no recovery and no revocation. Keep
 * the file it lives in private, and never commit it.
 */
/** The default filename used when a directory is given instead of a file. */
export declare const DEFAULT_ACCOUNT_FILE = "vector-bot-account.json";
/**
 * Environment variables checked for a private key, in order, when no account
 * file exists. Accepts an `nsec1…`, a 32-byte hex key, or a NIP-06 seed phrase.
 */
export declare const DEFAULT_KEY_ENV_VARS: readonly ["VECTOR_NSEC", "VECTOR_PRIVATE_KEY", "NOSTR_PRIVATE_KEY", "NSEC"];
/** Environment variables checked for a NIP-06 seed phrase. */
export declare const DEFAULT_MNEMONIC_ENV_VARS: readonly ["VECTOR_MNEMONIC", "NOSTR_MNEMONIC"];
export declare class AccountError extends Error {
}
/**
 * A bot account in every form you might need it.
 *
 * `nsec`/`privateKey` are the same secret in bech32 and hex; `npub`/`publicKey`
 * likewise for the public half. Vector and most clients show npub; most code
 * and relay filters want the hex.
 */
export interface VectorAccount {
    /** Public key, bech32 (`npub1…`). Safe to share — this is the bot's address. */
    npub: string;
    /** Public key, 32-byte hex. Safe to share. */
    publicKey: string;
    /** SECRET. Private key, bech32 (`nsec1…`). */
    nsec: string;
    /** SECRET. Private key, 32-byte hex. */
    privateKey: string;
    /**
     * SECRET. NIP-06 seed phrase, when the account was created with one or
     * derived from one. Twelve words that regenerate the key, so it is exactly as
     * sensitive as the key itself.
     */
    mnemonic?: string;
    /** When the account was first created, ISO 8601. */
    createdAt: string;
}
/** The half of an account that is safe to publish, log or paste anywhere. */
export interface PublicAccountInfo {
    npub: string;
    publicKey: string;
    createdAt: string;
}
/**
 * Create a brand-new bot account.
 *
 * With `withMnemonic` the key is derived from a fresh NIP-06 seed phrase, which
 * is written into the account so the key can be regenerated from twelve words
 * if the file is ever lost. Without it, the key comes straight from the system
 * CSPRNG and the file is the only copy.
 */
export declare function generateAccount(options?: {
    withMnemonic?: boolean;
}): VectorAccount;
/** Rebuild an account from an `nsec1…` or a 32-byte hex private key. */
export declare function accountFromKey(privateKey: string): VectorAccount;
/**
 * Derive an account from a NIP-06 seed phrase.
 *
 * `accountIndex` walks the derivation path, so one phrase can back several
 * bots — index 0 and index 1 are different keys from the same words.
 */
export declare function accountFromMnemonic(mnemonic: string, options?: {
    passphrase?: string;
    accountIndex?: number;
}): VectorAccount;
/** Strip an account down to what is safe to share. */
export declare function publicAccountInfo(account: VectorAccount): PublicAccountInfo;
/**
 * Write an account to disk as JSON, owner-readable only.
 *
 * The mode is applied on open *and* re-applied after writing, because an
 * existing file keeps its original permissions — otherwise re-saving over a
 * world-readable file would silently leave it that way. `chmod` is a no-op on
 * Windows, so there the directory is what protects the file.
 */
export declare function saveAccount(account: VectorAccount, target: string): Promise<string>;
/** Read an account back from disk. */
export declare function loadAccount(target: string): Promise<VectorAccount>;
/** Whether an account file already exists at `target`. */
export declare function accountExists(target: string): Promise<boolean>;
/** The result of trying to protect an account file from being shared. */
export interface IgnoreResult {
    /** Ignore files that now cover the account file. */
    updated: string[];
    /** Ignore files that already covered it. */
    alreadyIgnored: string[];
    /** The pattern written. */
    pattern: string;
}
/**
 * Make sure the account file cannot be committed or published by accident.
 *
 * Adds the file's pattern to the project's `.gitignore`, creating it if there
 * is none, and to `.npmignore` when that file exists — npm falls back to
 * `.gitignore` only when no `.npmignore` is present, so a project with one
 * would otherwise publish the key.
 *
 * Idempotent: a pattern already present is left alone.
 */
export declare function ensureAccountIgnored(target: string, options?: {
    projectRoot?: string;
}): Promise<IgnoreResult>;
/** Where a resolved account came from. */
export type AccountSource = 'file' | 'env' | 'created';
export interface ResolvedAccount {
    account: VectorAccount;
    source: AccountSource;
    /** Set when the account came from, or was written to, a file. */
    filePath?: string;
    /** Set when the account came from the environment. */
    envVar?: string;
}
/**
 * Get the bot's account: from its file, or failing that from the environment.
 *
 * The file wins when it exists, because it is the identity the bot has been
 * using. The environment is the fallback for places where writing a file is
 * awkward or wrong — a container, a CI run, a PaaS dyno — so the same code
 * works locally and deployed without a branch.
 *
 * With `create`, a missing file *and* empty environment mints a new account and
 * saves it, which is the keyless mode: nothing to configure on first run.
 */
export declare function resolveAccount(options?: {
    file?: string;
    env?: NodeJS.ProcessEnv;
    envVars?: readonly string[];
    mnemonicEnvVars?: readonly string[];
    create?: boolean;
    withMnemonic?: boolean;
    /** Add the account file to .gitignore when one is created. Defaults to true. */
    protect?: boolean;
}): Promise<ResolvedAccount>;
/**
 * Load the account at `target`, creating and saving one if there is none.
 *
 * This is the keyless mode: point a bot at a directory and it has a stable
 * identity from the first run onwards, with no key to paste. Give each bot its
 * own directory.
 */
export declare function loadOrCreateAccount(target: string, options?: {
    withMnemonic?: boolean;
}): Promise<{
    account: VectorAccount;
    filePath: string;
    created: boolean;
}>;
