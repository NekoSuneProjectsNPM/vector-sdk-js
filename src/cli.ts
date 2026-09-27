/**
 * `vector-bot` — the command-line front door.
 *
 * Creating a Vector bot means creating a Nostr keypair, and that is a thing you
 * do on your own machine rather than by signing up anywhere. This wraps it so
 * nobody has to write code to get a bot account, publish its profile, or add a
 * friend.
 */

import path from 'path';

import {
  accountFromKey,
  accountFromMnemonic,
  accountExists,
  DEFAULT_ACCOUNT_FILE,
  ensureAccountIgnored,
  generateAccount,
  resolveAccount as resolveStoredAccount,
  saveAccount,
  VectorAccount,
} from './identity.js';
import { VectorBot } from './bot.js';
import { Contacts } from './contacts.js';

const DEFAULT_RELAYS = [
  'wss://jskitty.cat/nostr',
  'wss://relay.damus.io',
  'wss://nostr.computingcache.com',
];

interface Options {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    // A flag takes the next token as its value unless that token is itself a
    // flag, which is what makes bare switches like `--mnemonic` work.
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(body, next);
      i += 1;
    } else {
      flags.set(body, true);
    }
  }

  return { positional, flags };
}

function flagString(options: Options, name: string): string | undefined {
  const value = options.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function accountPath(options: Options): string {
  return (
    flagString(options, 'file') ??
    process.env.VECTOR_ACCOUNT_FILE ??
    path.join(process.cwd(), DEFAULT_ACCOUNT_FILE)
  );
}

function relays(options: Options): string[] {
  const raw = flagString(options, 'relays') ?? process.env.NOSTR_RELAYS;
  if (!raw) {
    return DEFAULT_RELAYS;
  }
  return raw
    .split(',')
    .map((relay) => relay.trim())
    .filter(Boolean);
}

function printPublic(account: VectorAccount, file?: string): void {
  console.log('');
  console.log('  Bot account');
  console.log('  ───────────');
  console.log(`  npub (share this) : ${account.npub}`);
  console.log(`  pubkey (hex)      : ${account.publicKey}`);
  console.log(`  created           : ${account.createdAt}`);
  if (file) {
    console.log(`  saved to          : ${file}`);
  }
  console.log('');
}

function printSecrets(account: VectorAccount): void {
  console.log('  SECRET — anyone with these IS this bot. Never share or commit them.');
  console.log(`  nsec              : ${account.nsec}`);
  console.log(`  private key (hex) : ${account.privateKey}`);
  if (account.mnemonic) {
    console.log(`  seed phrase       : ${account.mnemonic}`);
    console.log('  Write the seed phrase down. It regenerates the key if the file is lost.');
  }
  console.log('');
}

/**
 * Find the account: an explicit --nsec wins, then the account file, then the
 * environment. A command that needs an identity should never make the user
 * think about which of those they are using.
 */
async function resolveAccount(options: Options): Promise<VectorAccount> {
  const explicitKey = flagString(options, 'nsec');
  if (explicitKey) {
    return accountFromKey(explicitKey);
  }

  const resolved = await resolveStoredAccount({ file: accountPath(options) });
  if (resolved.source === 'env') {
    console.error(`Using the key from $${resolved.envVar} (no account file found).`);
  }
  return resolved.account;
}

/** Build a connected bot from the resolved account. */
async function connect(options: Options, account: VectorAccount): Promise<VectorBot> {
  return VectorBot.new(
    account.nsec,
    flagString(options, 'name') ?? 'vector-bot',
    flagString(options, 'display-name') ?? 'Vector Bot',
    flagString(options, 'about') ?? 'Vector bot created with the SDK',
    flagString(options, 'picture') ?? '',
    flagString(options, 'banner') ?? '',
    flagString(options, 'nip05') ?? '',
    flagString(options, 'lud16') ?? '',
    { defaultRelays: relays(options) },
  );
}

async function cmdCreate(options: Options): Promise<number> {
  const file = accountPath(options);
  const force = options.flags.has('force');

  if ((await accountExists(file)) && !force) {
    console.error(`An account already exists at ${file}`);
    console.error('Pass --force to overwrite it, or --file to choose another path.');
    console.error('Overwriting loses the old key permanently, and with it the bot\'s identity.');
    return 1;
  }

  const fromMnemonic = flagString(options, 'from-mnemonic');
  const account = fromMnemonic
    ? accountFromMnemonic(fromMnemonic)
    : generateAccount({ withMnemonic: options.flags.has('mnemonic') });

  const saved = await saveAccount(account, file);
  printPublic(account, saved);

  // The file holds the bot's private key, so keep it out of git and out of any
  // published package before anything else touches the project.
  if (options.flags.get('protect') !== 'false') {
    try {
      const ignored = await ensureAccountIgnored(saved);
      for (const target of ignored.updated) {
        console.log(`  Added "${ignored.pattern}" to ${target}`);
      }
      for (const target of ignored.alreadyIgnored) {
        console.log(`  Already ignored by ${target}`);
      }
      console.log('');
    } catch (error) {
      console.error(`  Could not update .gitignore: ${String(error)}`);
      console.error(`  Add "${path.basename(saved)}" to it yourself before committing.`);
      console.error('');
    }
  }
  if (options.flags.has('show-secret') || account.mnemonic) {
    printSecrets(account);
  } else {
    console.log('  The private key is in the file above. Run `show --show-secret` to print it.');
    console.log('');
  }

  if (options.flags.has('publish')) {
    console.log('  Publishing profile and inbox relays…');
    await connect(options, account);
    console.log('  Published.');
    console.log('');
  } else {
    console.log('  Run `vector-bot publish-profile` to make the bot discoverable.');
    console.log('');
  }

  return 0;
}

async function cmdShow(options: Options): Promise<number> {
  const account = await resolveAccount(options);
  printPublic(account, accountPath(options));
  if (options.flags.has('show-secret')) {
    printSecrets(account);
  }
  return 0;
}

async function cmdPublishProfile(options: Options): Promise<number> {
  const account = await resolveAccount(options);
  // VectorBot.new publishes the kind-0 profile and the kind-10050 inbox relay
  // list as it builds, which is the whole job here.
  await connect(options, account);
  console.log(`Profile and inbox relays published for ${account.npub}`);
  return 0;
}

async function cmdSend(options: Options): Promise<number> {
  const [recipient, ...rest] = options.positional;
  const message = rest.join(' ');
  if (!recipient || !message) {
    console.error('Usage: vector-bot send <npub|hex> <message…>');
    return 1;
  }

  const account = await resolveAccount(options);
  const bot = await connect(options, account);
  const result = await bot.getChat(recipient).send(message);
  console.log(result.sent ? `Sent. id=${result.id}` : 'Send failed — no relay accepted it.');
  return result.sent ? 0 : 1;
}

async function cmdFriend(options: Options): Promise<number> {
  const [action, user] = options.positional;
  const account = await resolveAccount(options);
  const bot = await connect(options, account);
  const contacts = new Contacts(bot.client);

  if (action === 'list' || !action) {
    const list = await contacts.list();
    if (!list.length) {
      console.log('Not following anyone yet.');
      return 0;
    }
    console.log(`Following ${list.length}:`);
    for (const contact of list) {
      console.log(`  ${contact.npub}${contact.petname ? `  (${contact.petname})` : ''}`);
    }
    return 0;
  }

  if (!user) {
    console.error(`Usage: vector-bot friend ${action} <npub|hex>`);
    return 1;
  }

  if (action === 'add') {
    const list = await contacts.add(user, { petname: flagString(options, 'petname') });
    console.log(`Added. Now following ${list.length}.`);
    return 0;
  }

  if (action === 'remove') {
    const list = await contacts.remove(user);
    console.log(`Removed. Now following ${list.length}.`);
    return 0;
  }

  console.error(`Unknown friend action: ${action}. Use add, remove or list.`);
  return 1;
}

function usage(): void {
  console.log(`
vector-bot — create and run a Vector bot account

USAGE
  vector-bot <command> [options]

COMMANDS
  create                 Create a bot account and save it to a file
    --mnemonic           Also generate a 12-word seed phrase that can restore the key
    --from-mnemonic "…"  Restore an account from an existing seed phrase
    --publish            Publish the profile and inbox relays straight away
    --force              Overwrite an existing account file (destroys the old key)
    --show-secret        Print the private key to the terminal
    --protect=false      Do NOT add the account file to .gitignore

  show                   Print the account's public details
    --show-secret        Also print the private key and seed phrase

  publish-profile        Publish the kind-0 profile and kind-10050 inbox relays
  send <npub> <message…> Send a direct message
  friend list            Show everyone the bot follows
  friend add <npub>      Follow someone            [--petname "name"]
  friend remove <npub>   Unfollow someone

COMMON OPTIONS
  --file <path>          Account file (default: ./${DEFAULT_ACCOUNT_FILE})
  --nsec <nsec1…>        Use this key instead of an account file
  --relays "a,b,c"       Relays to use (default: Vector's)
  --name, --display-name, --about, --picture, --banner, --nip05, --lud16
                         Profile fields, used when publishing

IDENTITY RESOLUTION
  Commands look for the bot's key in this order:
    1. --nsec on the command line
    2. the account file (--file, or $VECTOR_ACCOUNT_FILE, or ./vector-bot-account.json)
    3. the environment, for deployments with no writable disk:
         VECTOR_NSEC, VECTOR_PRIVATE_KEY, NOSTR_PRIVATE_KEY, NSEC
         VECTOR_MNEMONIC, NOSTR_MNEMONIC  (NIP-06 seed phrase)

ENVIRONMENT
  VECTOR_ACCOUNT_FILE    Default account file path
  VECTOR_NSEC            Key to use when there is no account file
  NOSTR_RELAYS           Default relay list, comma-separated

EXAMPLES
  vector-bot create --mnemonic --publish
  vector-bot show
  vector-bot friend add npub1… --petname "owner"
  vector-bot send npub1… "hello from my bot"

The account file holds the bot's private key. Anyone who has it IS the bot.
Keep it out of git.
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const command = options.positional.shift();

  if (!command || command === 'help' || options.flags.has('help')) {
    usage();
    return 0;
  }

  try {
    switch (command) {
      case 'create':
        return await cmdCreate(options);
      case 'show':
        return await cmdShow(options);
      case 'publish-profile':
        return await cmdPublishProfile(options);
      case 'send':
        return await cmdSend(options);
      case 'friend':
        return await cmdFriend(options);
      default:
        console.error(`Unknown command: ${command}`);
        usage();
        return 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// Only take over the process when run as a program, so importing this module
// from a test or another tool stays side-effect free.
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;

if (invokedDirectly || process.env.VECTOR_BOT_CLI === '1') {
  main()
    .then((code) => {
      // Relay sockets keep the loop alive, so say the work is done and leave.
      process.exit(code);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
