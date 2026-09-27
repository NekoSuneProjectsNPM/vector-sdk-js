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
import { promises as fs } from 'fs';
import path from 'path';
import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { accountFromSeedWords, generateSeedWords, validateWords, } from 'nostr-tools/nip06';
import { bytesToHex } from 'nostr-tools/utils';
import { normalizePrivateKey } from './keys.js';
/** The default filename used when a directory is given instead of a file. */
export const DEFAULT_ACCOUNT_FILE = 'vector-bot-account.json';
/**
 * Environment variables checked for a private key, in order, when no account
 * file exists. Accepts an `nsec1…`, a 32-byte hex key, or a NIP-06 seed phrase.
 */
export const DEFAULT_KEY_ENV_VARS = [
    'VECTOR_NSEC',
    'VECTOR_PRIVATE_KEY',
    'NOSTR_PRIVATE_KEY',
    'NSEC',
];
/** Environment variables checked for a NIP-06 seed phrase. */
export const DEFAULT_MNEMONIC_ENV_VARS = [
    'VECTOR_MNEMONIC',
    'NOSTR_MNEMONIC',
];
export class AccountError extends Error {
}
function accountFromBytes(privateKeyBytes, mnemonic, createdAt) {
    const privateKey = bytesToHex(privateKeyBytes);
    const publicKey = getPublicKey(privateKeyBytes);
    return {
        npub: nip19.npubEncode(publicKey),
        publicKey,
        nsec: nip19.nsecEncode(privateKeyBytes),
        privateKey,
        ...(mnemonic ? { mnemonic } : {}),
        createdAt: createdAt ?? new Date().toISOString(),
    };
}
/**
 * Create a brand-new bot account.
 *
 * With `withMnemonic` the key is derived from a fresh NIP-06 seed phrase, which
 * is written into the account so the key can be regenerated from twelve words
 * if the file is ever lost. Without it, the key comes straight from the system
 * CSPRNG and the file is the only copy.
 */
export function generateAccount(options = {}) {
    if (options.withMnemonic) {
        const mnemonic = generateSeedWords();
        const { privateKey } = accountFromSeedWords(mnemonic);
        return accountFromBytes(privateKey, mnemonic);
    }
    return accountFromBytes(generateSecretKey());
}
/** Rebuild an account from an `nsec1…` or a 32-byte hex private key. */
export function accountFromKey(privateKey) {
    const normalized = normalizePrivateKey(privateKey);
    return accountFromBytes(normalized.bytes);
}
/**
 * Derive an account from a NIP-06 seed phrase.
 *
 * `accountIndex` walks the derivation path, so one phrase can back several
 * bots — index 0 and index 1 are different keys from the same words.
 */
export function accountFromMnemonic(mnemonic, options = {}) {
    const words = mnemonic.trim().replace(/\s+/g, ' ');
    if (!validateWords(words)) {
        throw new AccountError('Not a valid NIP-06 seed phrase');
    }
    const { privateKey } = accountFromSeedWords(words, options.passphrase, options.accountIndex);
    return accountFromBytes(privateKey, words);
}
/** Strip an account down to what is safe to share. */
export function publicAccountInfo(account) {
    return {
        npub: account.npub,
        publicKey: account.publicKey,
        createdAt: account.createdAt,
    };
}
/** Resolve a path that may be either a directory or a file to the file. */
function resolveAccountPath(target) {
    const looksLikeFile = path.extname(target) !== '';
    return looksLikeFile ? target : path.join(target, DEFAULT_ACCOUNT_FILE);
}
/**
 * Write an account to disk as JSON, owner-readable only.
 *
 * The mode is applied on open *and* re-applied after writing, because an
 * existing file keeps its original permissions — otherwise re-saving over a
 * world-readable file would silently leave it that way. `chmod` is a no-op on
 * Windows, so there the directory is what protects the file.
 */
export async function saveAccount(account, target) {
    const filePath = resolveAccountPath(target);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(account, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    try {
        await fs.chmod(filePath, 0o600);
    }
    catch {
        // Unsupported on this platform; the containing directory is the guard.
    }
    return filePath;
}
/** Read an account back from disk. */
export async function loadAccount(target) {
    const filePath = resolveAccountPath(target);
    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    }
    catch (error) {
        throw new AccountError(`No account file at ${filePath}: ${String(error)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new AccountError(`Account file is not valid JSON: ${String(error)}`);
    }
    const secret = parsed.privateKey || parsed.nsec;
    if (!secret) {
        throw new AccountError(`Account file has no private key: ${filePath}`);
    }
    // Rebuild every field from the secret rather than trusting what is on disk,
    // so a hand-edited or truncated file cannot produce an account whose npub
    // does not match its key.
    const normalized = normalizePrivateKey(secret);
    return accountFromBytes(normalized.bytes, parsed.mnemonic, parsed.createdAt);
}
/** Whether an account file already exists at `target`. */
export async function accountExists(target) {
    try {
        await fs.access(resolveAccountPath(target));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Walk up from `start` looking for the project root — the nearest directory
 * holding a `.git` or a `package.json`. Falls back to `start` itself.
 */
async function findProjectRoot(start) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 20; depth += 1) {
        for (const marker of ['.git', 'package.json']) {
            try {
                await fs.access(path.join(dir, marker));
                return dir;
            }
            catch {
                // keep climbing
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return path.resolve(start);
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
export async function ensureAccountIgnored(target, options = {}) {
    const filePath = path.resolve(resolveAccountPath(target));
    const root = options.projectRoot
        ? path.resolve(options.projectRoot)
        : await findProjectRoot(path.dirname(filePath));
    // A path inside the project is ignored by its relative path; one outside it
    // cannot be expressed that way, so fall back to the bare filename.
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    const pattern = relative && !relative.startsWith('..') ? relative : path.basename(filePath);
    const updated = [];
    const alreadyIgnored = [];
    const candidates = [
        { name: '.gitignore', createIfMissing: true },
        // Only touch .npmignore if the project already uses one. Creating it would
        // switch npm off .gitignore entirely and change what the project ships.
        { name: '.npmignore', createIfMissing: false },
    ];
    for (const { name, createIfMissing } of candidates) {
        const ignorePath = path.join(root, name);
        let contents = null;
        try {
            contents = await fs.readFile(ignorePath, 'utf8');
        }
        catch {
            if (!createIfMissing) {
                continue;
            }
        }
        const lines = (contents ?? '').split(/\r?\n/).map((line) => line.trim());
        if (lines.includes(pattern) || lines.includes(`/${pattern}`)) {
            alreadyIgnored.push(ignorePath);
            continue;
        }
        const prefix = contents === null || contents.length === 0 || contents.endsWith('\n') ? '' : '\n';
        const block = `${prefix}\n# Vector bot account — holds the bot's private key. Never commit this.\n${pattern}\n`;
        await fs.appendFile(ignorePath, block, 'utf8');
        updated.push(ignorePath);
    }
    return { updated, alreadyIgnored, pattern };
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
export async function resolveAccount(options = {}) {
    const env = options.env ?? process.env;
    const filePath = resolveAccountPath(options.file ?? env.VECTOR_ACCOUNT_FILE ?? DEFAULT_ACCOUNT_FILE);
    if (await accountExists(filePath)) {
        return { account: await loadAccount(filePath), source: 'file', filePath };
    }
    for (const name of options.envVars ?? DEFAULT_KEY_ENV_VARS) {
        const value = env[name]?.trim();
        if (value) {
            return { account: accountFromKey(value), source: 'env', envVar: name };
        }
    }
    for (const name of options.mnemonicEnvVars ?? DEFAULT_MNEMONIC_ENV_VARS) {
        const value = env[name]?.trim();
        if (value) {
            return { account: accountFromMnemonic(value), source: 'env', envVar: name };
        }
    }
    if (!options.create) {
        const tried = [
            ...(options.envVars ?? DEFAULT_KEY_ENV_VARS),
            ...(options.mnemonicEnvVars ?? DEFAULT_MNEMONIC_ENV_VARS),
        ].join(', ');
        throw new AccountError(`No account found. Looked for the file ${filePath}, then the environment (${tried}). ` +
            'Run `vector-bot create`, set one of those variables, or pass create: true.');
    }
    const account = generateAccount({ withMnemonic: options.withMnemonic });
    await saveAccount(account, filePath);
    if (options.protect !== false) {
        await ensureAccountIgnored(filePath).catch(() => {
            // Not being able to write .gitignore must not stop the bot from starting.
        });
    }
    return { account, source: 'created', filePath };
}
/**
 * Load the account at `target`, creating and saving one if there is none.
 *
 * This is the keyless mode: point a bot at a directory and it has a stable
 * identity from the first run onwards, with no key to paste. Give each bot its
 * own directory.
 */
export async function loadOrCreateAccount(target, options = {}) {
    const filePath = resolveAccountPath(target);
    if (await accountExists(filePath)) {
        return { account: await loadAccount(filePath), filePath, created: false };
    }
    const account = generateAccount(options);
    await saveAccount(account, filePath);
    return { account, filePath, created: true };
}
