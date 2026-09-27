# Vector Bot SDK (Node.js)

A JavaScript/TypeScript implementation of the Vector Bot SDK. It tracks the wire
format of VectorApp's Rust SDK (`crates/vector-sdk`) and the `vector-core`
engine underneath it, while staying idiomatic for Node.

## Highlights

- **Slash commands** with typed arguments, published as a Bot Interface Manifest
  (kind 10304) so every Vector client renders a `/` picker for your bot.
- `VectorBotClient`, `VectorBot` and `Channel` for messages, replies, edits,
  deletions, reactions, typing indicators and files.
- **NIP-17 delivery**: gift wraps go to the recipient's published inbox relays
  (kind 10050), not just your own, and the bot publishes its own list on connect.
- Self-wrapping, so the account's other devices see what the bot sent.
- NIP-40 self-destruct, NIP-30 custom emoji, threaded replies.
- Attachment send *and* receive, with AES-256-GCM decryption.
- Partial relay failures don't fail a send when at least one relay accepts it.
- Legacy Vector MLS group support through an `mlsAdapter` sidecar bridge.

## Install

```bash
npm install @nekosuneprojects/vector-sdk
```

## Create a bot account

A Vector bot *is* a Nostr keypair. There is no signup and no server to ask — you
mint one locally and it exists immediately.

```bash
npx vector-bot create --mnemonic --publish
```

That writes `vector-bot-account.json` next to your project, **adds it to
`.gitignore`** (and `.npmignore`, if you have one) so it can never be committed
or published, prints the bot's `npub` to share, and publishes its profile and
inbox relays so people can reach it.

`--mnemonic` also gives you a twelve-word seed phrase that regenerates the key
if the file is ever lost. Write it down.

| Command | What it does |
| --- | --- |
| `vector-bot create` | Make an account. `--mnemonic`, `--publish`, `--force`, `--from-mnemonic "…"` |
| `vector-bot show` | Print the npub and pubkey. `--show-secret` for the private key |
| `vector-bot publish-profile` | Publish the kind-0 profile and kind-10050 inbox relays |
| `vector-bot send <npub> <msg>` | Send a direct message |
| `vector-bot friend add/remove/list` | Manage the bot's NIP-02 contact list |

> **The account file is the bot.** Anyone holding that private key can read the
> bot's messages and send as it. There is no recovery and no revocation.

### Where the key is read from

Commands look for the key in this order, so the same code works locally and
deployed without a branch:

1. `--nsec` on the command line
2. the account file — `--file`, `$VECTOR_ACCOUNT_FILE`, or `./vector-bot-account.json`
3. the environment, for containers and CI with no writable disk:
   `VECTOR_NSEC`, `VECTOR_PRIVATE_KEY`, `NOSTR_PRIVATE_KEY`, `NSEC`, or a NIP-06
   seed phrase in `VECTOR_MNEMONIC` / `NOSTR_MNEMONIC`

In code, `resolveAccount` does the same thing:

```ts
import { resolveAccount } from '@nekosuneprojects/vector-sdk';

// File if present, else the environment, else mint one and save it.
const { account, source } = await resolveAccount({ create: true });
console.log(`Running as ${account.npub} (from ${source})`);
```

## Getting started

```ts
import { VectorBotClient } from '@nekosuneprojects/vector-sdk';

const client = new VectorBotClient({
  privateKey: process.env.NOSTR_PRIVATE_KEY!,
  relays: (process.env.NOSTR_RELAYS ?? 'wss://jskitty.cat/nostr,wss://relay.damus.io')
    .split(',')
    .map((relay) => relay.trim())
    .filter(Boolean),
  profile: {
    name: 'testnekobot',
    displayName: 'NekoSune TestBOT',
    about: 'Vector bot created with the SDK',
  },
  debug: process.env.DEBUG === '1',
});

client.on('ready', ({ pubkey, commands }) => {
  console.log(`Online as ${pubkey} with ${commands} command(s)`);
});

client.on('message', async (senderPubkey, tags, message, self) => {
  if (self) return;
  await client.replyTo(senderPubkey, tags.messageId!, `You said: ${message}`);
});

await client.connect();
```

## Slash commands

Declare a command with typed arguments and the manifest publishes when the
client connects. Vector clients then render a `/` picker with a field per
argument — a dropdown for a choice, a member picker for a user, a number field
for an int — and validate the input *before* it is sent. Your handler receives
the arguments already parsed and type-checked.

```ts
client.command('weather', 'Current conditions for a city')
  .string('city', 'Which city', true)                   // required free text
  .choice('units', 'Temperature units', ['c', 'f'])     // optional dropdown
  .run(async (ctx) => {
    const city = ctx.str('city') ?? '';
    const units = ctx.str('units') ?? 'c';
    await ctx.reply(`Weather in ${city} (°${units.toUpperCase()})…`);
  });
```

Argument types: `.string()`, `.int()`, `.number()`, `.flag()` (bool), `.user()`
(an npub) and `.choice(name, description, options, required)`. Read them off the
context with `ctx.str/int/number/flag(name)`.

A trailing `.string()` swallows the rest of the line, so `/say hello there` is
one value. Quoting groups words anywhere: `/announce "Big news" "Meeting at 5pm"`.

A matched command runs its handler and is **consumed** — it never reaches the
`message` event, so commands and free-form chat live side by side without your
handler re-parsing text. An invocation that matches a command *name* but fails
typing gets the canonical two-line error (`{arg}: {reason}` then `usage: …`) and
is still consumed.

### Answering in a group, or privately

Commands work in groups as well as DMs. The context gives you the choice of
where the answer lands:

| Method | Where the answer goes |
| --- | --- |
| `ctx.reply(text)` | Where the command was invoked — the group if it came from a group, the DM if it came from a DM. |
| `ctx.replyPrivately(text)` | The invoker's DM, **even when the command was invoked in a group**. The group sees nothing. |
| `ctx.dm(user, text)` | Any user, by npub or hex pubkey. |

`ctx.isGroup` and `ctx.groupId` tell you where you are.

```ts
client.command('balance', 'Check your balance')
  .run(async (ctx) => {
    // In a channel this stays between the bot and whoever asked.
    await ctx.replyPrivately(`Your balance is ${await lookup(ctx.senderPubkey)}`);
    if (ctx.isGroup) {
      await ctx.reply('Sent you a DM.');
    }
  });

client.command('gift', 'Send someone a gift')
  .user('who', 'Who to gift', true)
  .int('amount', 'How much', true)
  .run(async (ctx) => {
    const who = ctx.str('who')!;          // normalized to a bare npub
    await ctx.dm(who, `You were gifted ${ctx.int('amount')} by ${ctx.senderPubkey}`);
    await ctx.reply(`Gift sent to ${who}`);
  });
```

Group replies go through the configured group transport, so a group-answering
command needs `mlsAdapter` set (see below). `ctx.replyPrivately` and `ctx.dm`
are plain DMs and need nothing extra.

### Addressing

A client may tag an invocation for specific bots with `["bot", <hex>]`. Tagged
means only those bots execute, so two bots can share a command name; untagged is
broadcast, so the tag is never required. Incoming messages expose it as
`tags.addressedBots`.

## Messaging

Every send returns `{ id, sent }`. The `id` is the message id that replies,
edits, reactions and deletions reference.

```ts
const { id } = await client.send(pubkey, 'hello');

await client.replyTo(pubkey, id, 'a threaded reply');
await client.editMessage(pubkey, id, 'hello (edited)');
await client.react(pubkey, id, '👍');
await client.react(pubkey, id, ':party:', { emojiUrl: 'https://…/party.png' });
await client.typing(pubkey);
await client.deleteMessage(pubkey, id);

// Self-destructing message: a Unix timestamp in seconds.
await client.send(pubkey, 'gone in an hour', {
  expiration: Math.floor(Date.now() / 1000) + 3600,
});
```

## Friends and invites

```ts
await client.addFriend('npub1…', { petname: 'owner' });
await client.removeFriend('npub1…');
const friends = await client.getFriends();
```

Friends are a NIP-02 contact list (kind 3): a public, replaceable address book.
Vector does not use it to decide who may talk to the bot — any npub can DM any
other npub — so treat it as discoverability, not access control. Each change
re-fetches the published list and republishes it whole, so a restart or a second
client cannot silently drop everyone.

Community invites arrive as gift-wrapped bundles and are surfaced as they land:

```ts
client.on('invite', ({ invite, senderPubkey, expired }) => {
  if (expired) return;
  console.log(`Invited to ${invite.name} (${invite.communityId}) by ${senderPubkey}`);
});

// Pass an invite the bot holds on to someone else.
await client.forwardInvite('npub1…', invite.communityId);
```

### Accepting, listing and leaving

```ts
// Accept: keeps the access key, epoch and channel keys the bundle vended.
await client.acceptInvite(invite.communityId);

// discord.js-shaped, so this should look familiar:
const communities = await client.communities.fetch();
console.log(`In ${communities.size} communities`);
for (const community of communities.toArray()) {
  console.log(`${community.name} — ${community.channels.length} channels`);
}

const one = client.communities.get(id);
await one.leave();              // or: client.communities.leave(id)
```

From the terminal: `vector-bot community list` and `vector-bot community leave <id>`.

### Members and user info

```ts
const user = await client.users.fetch('npub1…');
user.displayName;            // always something, falls back to a short npub
user.username;               // the handle, if they set one
user.about; user.avatarURL; user.nip05; user.bot;
await user.verifyNip05();    // checks the claim against the domain
await user.send('hello');

const community = client.communities.get(id);
for (const member of await community.members.fetch()) {
  console.log(member.user.displayName, member.isOwner ? '(owner)' : member.source);
}
```

> **`community.members` is partial, and says so.** `members.complete` is
> `false`. The real roster lives in the community's Guestbook, sealed under a
> key derived from the community secret, so reading it needs the Concord v2
> stream layer. What is knowable today: the **owner** — self-certified, since
> the community id is a hash commitment to it — the **inviter**, from the
> verified seal, and anyone you `observe()`. Check `complete` before showing a
> member count.

Repeat invites to the same community collapse to a single entry — the
longest-lived one wins, since an older wrap can be the one with life left in it.
`clearInvites()` drops held invites and `pruneInvites()` drops only expired ones.

> **Accepting records membership; it does not yet make the bot a participant.**
> Announcing the join and reading or posting in a channel ride the Concord v2
> stream layer, which this package does not implement. A bot holds valid
> credentials and is ready, but the community cannot see it and it cannot read
> the room. `community.announced` stays `false` to mark exactly that.

A bot can read and forward invites, but **cannot create them**. A bundle carries
live key material for the community, which only a member holding that
community's state can produce — and that state lives in `vector-core`. The
original NIP-40 expiry is preserved on forward, so passing one on never outlives
what the issuer granted.

## Files

```ts
await client.sendFile(pubkey, '/path/to/photo.jpg');

client.on('attachment', async ({ sender, attachment }) => {
  await client.saveAttachment(attachment, `./downloads/${attachment.filename ?? 'file'}`);
});
```

Attachments are encrypted with AES-256-GCM, uploaded to Vector's NIP-96 server,
and sent as a gift-wrapped kind 15 rumor. Received attachments also arrive on the
`message` event as `tags.attachment`.

## Events

| Event | Fires when |
| --- | --- |
| `ready` | Connected. Reports `pubkey`, `profile`, `commands`, `knownGroupIds`. |
| `message` | A message arrived: `(senderPubkey, tags, content, self)`. |
| `command` | A registered command matched. |
| `attachment` | A file attachment arrived. |
| `message_update` | An edit landed. |
| `reaction` | A reaction landed. |
| `message_delete` | A deletion request landed. |
| `typing` | A typing indicator arrived. |
| `manifest_published` | The command manifest went out. |
| `disconnect` / `reconnect` / `error` | Relay lifecycle. |
| `group_discovered` / `group_wrapper` / `mls_welcome` | Legacy MLS group path. |

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `useInboxRelays` | `true` | Deliver gift wraps to the recipient's kind-10050 inbox relays. |
| `selfWrap` | `true` | Also wrap each send to the bot itself, for multi-device visibility. |
| `legacyNip04` | `false` | Also send DMs as NIP-04 (kind 4). Vector ignores kind 4. |
| `publishManifest` | `true` | Publish the command manifest on connect. |
| `discoveryRelays` | `purplepag.es`, `relay.nostr.band`, `nos.lol` | Extra relays for manifest and inbox-list discovery. |
| `reconnect` / `reconnectIntervalMs` | `true` / `15000` | Relay reconnection. |

## Vector private groups

Group support here is the legacy Vector MLS path (kinds 443/444). Set
`MLS_SIDECAR_BIN` to the compiled Rust sidecar (`RUST/mls-sidecar`) and pass an
adapter so group wrappers can be decrypted and group replies sent:

```ts
import { createMlsSidecarAdapter } from '@nekosuneprojects/vector-sdk';

const mlsAdapter = createMlsSidecarAdapter({
  binPath: process.env.MLS_SIDECAR_BIN!,
  stateDir: process.env.MLS_STATE_DIR ?? '.vector-mls-sidecar',
});

const client = new VectorBotClient({
  privateKey,
  relays,
  mlsAdapter,
  vectorOnly: true,
  autoDiscoverGroups: true,
  discoverGroupsFromHistory: true,
});
```

VectorApp has since moved communities to the **Concord v2** protocol (kinds
3300-3311), whose encrypted envelopes, epoch keys and consensus folding live in
`vector-core` and are not implemented in this package. The v2 kind constants are
exported from `kinds` so you can recognise that traffic:

```ts
import { kinds } from '@nekosuneprojects/vector-sdk';

kinds.isCommunityKind(event.kind); // true for 3300-3311
```

## Fixing a wrongly-set bot badge

Vector only re-evaluates its bot badge when a profile **contains** a `bot`
field. A profile that simply omits it leaves the existing flag alone — so an
account wrongly marked as a bot cannot be fixed by removing the field. The only
thing that clears it is publishing `"bot": false`.

```bash
# Dry run first — shows exactly what would change, publishes nothing.
node scripts/fix-bot-flag.mjs --nsec nsec1...

# Then publish.
node scripts/fix-bot-flag.mjs --nsec nsec1... --yes
```

It reads your current profile, writes it back with only `bot` changed, and
leaves every other field exactly as it was. Pass the key via `$VECTOR_NSEC`
instead of `--nsec` to keep it out of your shell history. In code:
`await client.setBotFlag(false)`.

To avoid the problem: pass `bot: false` when running under a human's key, or
`publishProfile: false` to leave the profile alone entirely.

## Building and testing

```bash
npm run build   # emit dist/
npm test        # build, then run the bot-interface parity suite
```

The parity suite runs the `vector_core::bot_interface` test vectors against this
package's port of the manifest parser, validator and error strings, so a command
typed in Vector resolves to the same arguments here as it would in the Rust SDK.
