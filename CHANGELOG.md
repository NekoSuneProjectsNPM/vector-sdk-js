# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are drafted by [Release Drafter](.github/release-drafter.yml) from
merged pull requests; this file is the curated, hand-written record of what
changed in each version.

## [Unreleased]

## [1.3.1] - 2026-09-27

Concord v2: a bot can now join a community and read and post in it. Until this,
accepting an invite kept the keys but left the bot invisible — the community had
no record of it, and it could not read the room.

Two things remain out: the **control-plane fold**, so channels created after the
invite, renames, the community banlist and the owner-anchor check on join are
not yet seen; and **following rekeys**, so after a key rotation the bot needs a
fresh invite.

### Added

- **Key derivation** (`concord/derive`), ported from
  `vector_core::community::v2::derive`: HKDF-SHA256 over the frozen
  `CORD-02 Appendix A` labels, giving the channel, control, control-signer,
  guestbook, rekey and dissolved keys plus the community-id and epoch-key
  commitments. Checked against the **golden vectors minted by an independent
  implementation** upstream, so the derivation is byte-identical to the spec —
  which everything above it depends on.
- **The stream envelope** (`concord/stream`): Concord's reversed seal-and-wrap,
  where the wrap key comes from the group key rather than an ephemeral keypair.
- **Community chat.** The client follows every accepted community:
  `community_message` delivers each message with `reply()` and `react()`, and
  `sendCommunityMessage`, `editCommunityMessage`, `deleteCommunityMessage`,
  `reactInCommunity` and `communityTyping` post in a channel by id or name.
  Edits, deletes, reactions and typing from others arrive as their own events.
  Every event is verified before it surfaces: wrap address, seal signature,
  seal and rumor naming the same author, a recomputed rumor id, and the exact
  channel and epoch binding, so a message cannot be spliced across channels or
  epochs. The bot's own messages are never echoed back.
- **Guestbook join and leave.** A first join is announced once, echoing the
  invite's attribution; an earlier join by the same account is found on the
  relays and adopted instead of re-announced. Leaving publishes the leave
  before the keys are discarded. Live joins, leaves and kicks arrive as
  `community_member_*` events.
- **`concord` exports**: the v2 key derivations, the stream envelope, and the
  chat and guestbook builders and parsers, for anything the client does not
  wrap.

### Changed

- Accepting an invite no longer stops at storing keys: the join is announced, so
  the community sees the bot and `announced` becomes meaningful.

### Security

- **An invite whose community id does not commit to its claimed owner is
  refused** on accept (`InviteRejected`, reason `bad-community-id`), and a
  stored community failing the same check is not followed. The id is
  `sha256("concord/community" || owner || salt)`; a mismatch means a forged or
  corrupt bundle. This is the eclipse check `vector-core` calls for — the owner
  commitment proves who the owner is, so a bundle that fails it could otherwise
  partition a bot onto a plane an attacker controls.

## [1.3.0] - 2026-09-27

Closes a sender-spoofing hole present in every earlier release, makes invites
from current Vector clients visible at all, and adds communities, members and
user profiles.

### Security

- **Incoming messages were not authenticated, so any sender could impersonate
  any account.** A NIP-59 rumor is unsigned — the signature lives on the kind-13
  seal — but `nostr-tools`' `unwrapEvent` verifies neither the seal's signature
  nor that the rumor's `pubkey` agrees with who signed it. The client trusted
  `rumor.pubkey` for every message, command and reply, so anyone could seal a
  rumor attributed to someone else and have a bot act on it as that person,
  including whoever the bot trusts for privileged commands.

  `unwrapGiftWrap()` replaces it: Schnorr-verify the seal, require the rumor to
  name the same author, and re-derive the rumor id so a sender cannot point
  replies, reactions or deletions at an event they did not write. It throws
  rather than returning null — a wrap failing these checks is a forgery attempt,
  never an ordinary message. This is the check `vector-core` calls mandatory:
  the seal's npub "is the only proof of who invited".

  Affects every release before 1.2.0. Bots authorizing on sender should treat
  prior traffic as unauthenticated.

### Fixed

- **Connecting with a key overwrote that account's profile.** `VectorBot.new()`
  published a kind-0 on every connect, and kind 0 is *replaceable* — a publish
  replaces the whole profile. Anyone who ran the SDK or CLI with a personal key
  had their name, picture and bio erased and replaced with the bot defaults, and
  was stamped `bot: true`. Publishing now merges over what the account already
  has, `publishProfile: false` skips it, and `bot: false` keeps a human account
  unflagged.

- **A wrongly-set bot badge could not be cleared.** Vector only re-evaluates the
  badge when a profile *contains* a `bot` field; one that omits it leaves the
  existing flag untouched. So removing the field does nothing — only publishing
  `bot: false` clears it. `client.setBotFlag(false)` does that while carrying
  every other field over, and `scripts/fix-bot-flag.mjs` is a standalone version
  for an account that never goes near the SDK. `metadataToContent()` keeps a
  `false` value rather than dropping it as empty, since dropping it would make
  the badge unclearable.

- **Community invites from current Vector clients were invisible.** Invites were
  read as kind 3304, the *v1* bundle; a modern client sends a Concord v2 Direct
  Invite, **kind 3313**, in a different wire-frozen shape (`community_root` /
  `root_epoch`, not `server_root_key` / `server_root_epoch`). Both generations
  are now read, with the protocol reported as `invite.protocol`, and forwarding
  preserves the issuing kind. Verified against five live invites on
  `wss://jskitty.cat/nostr`.
- A v2 bundle states its own expiry in milliseconds, which is used when the
  gift wrap carries no NIP-40 tag — previously such an invite looked permanent.

- A v2 bundle states its own expiry in milliseconds, which is used when the
  gift wrap carries no NIP-40 tag — previously such an invite looked permanent.

### Added

- **Accepting invites.** `client.acceptInvite(id)` keeps what the bundle vended
  — the base access key, its epoch and any channel keys — in a communities file
  written owner-only, since those are credentials. Re-accepting replaces the
  entry, which is how a bot picks up rotated keys. An expired invite is refused:
  past its deadline the preview still renders but the keys are stale.

- **Communities, discord.js-shaped.** `client.communities` is a manager with
  `.fetch()`, `.cache`, `.get(id)`, `.resolve(id)` and `.leave(id)`; each
  `Community` has `.id`, `.name`, `.channels`, `.relays`, `.joinedAt` and
  `.leave()`. The cache fills on `fetch()`, as in discord.js. `vector-bot
  community list` and `community leave <id>` do the same from the terminal.

- **Invites no longer pile up.** Repeat invites to the same community collapse
  to one entry, and the longest-lived wins rather than merely the last seen — an
  older wrap can be the one with life left in it. `clearInvites()` drops held
  invites, `pruneInvites()` drops only expired ones, and accepting removes the
  invite it consumed. Five real invites on the wire now present as one.

- **Users and profiles**, discord.js-style. `client.users.fetch(npub)` returns a
  `User` with `displayName`, `username`, `about`, `avatarURL`, `bannerURL`,
  `nip05`, `lud16` and `bot`, plus `send()`, `dmRelays()` and `verifyNip05()`,
  which checks the claim against the domain it names rather than trusting it.
  `fetchMany()` resolves a set in one relay query. `displayName` always returns
  something, falling back to a short npub, so a caller never needs its own
  fallback. Misses are cached too — an account with no profile is ordinary, and
  re-querying on every mention costs more than the empty result is worth.

- **Community members**, as far as they are knowable. `community.members` lists
  the **owner** (self-certified: the community id is a hash commitment to it),
  the **inviter** (from the verified seal), and anyone `observe()`d. Each entry
  carries its `source`, because the evidence differs in strength.
  `members.complete` is `false` and will stay so until the v2 stream layer
  lands: the real roster is the community's Guestbook, sealed under a key
  derived from the community secret. It is reported rather than hidden so a
  short list is not mistaken for a small community.
- Concord v2 kind constants: `COMMUNITY_DIRECT_INVITE` (3313),
  `COMMUNITY_SNAPSHOT` (3312), `COMMUNITY_COMMENT`, the ephemeral typing kind and
  the public invite bundle kind.

- Concord v2 kind constants: `COMMUNITY_DIRECT_INVITE` (3313),
  `COMMUNITY_SNAPSHOT` (3312), `COMMUNITY_COMMENT`, the ephemeral typing kind and
  the public invite bundle kind.

## [1.2.0] - 2026-09-27

Bot accounts: creating one, storing it safely, and the things a bot needs an
identity for.

### Added

- **Bot accounts.** `generateAccount()` mints a Nostr keypair and returns it in
  every form you need — `npub`/`publicKey` to share, `nsec`/`privateKey` to keep
  — plus an optional twelve-word NIP-06 seed phrase that regenerates the key.
  `accountFromKey`, `accountFromMnemonic`, `saveAccount` and `loadAccount` round
  a bot's identity through disk. Loading re-derives every field from the private
  key, so a hand-edited file cannot claim an npub it does not own.

- **The `vector-bot` CLI**, for anyone who would rather not write code to get a
  bot: `create`, `show`, `publish-profile`, `send` and `friend add/remove/list`.
  `vector-bot create --mnemonic --publish` is a working, discoverable bot in one
  command.

- **The account file is protected on creation.** `ensureAccountIgnored()` adds it
  to the project's `.gitignore`, creating one if needed, and to `.npmignore` when
  the project already has one — npm only falls back to `.gitignore` when no
  `.npmignore` exists, so a project with one would otherwise publish the key.
  Idempotent, and it never invents an `.npmignore`, which would silently change
  what the project ships.

- **`resolveAccount()`** reads the account file when it exists and falls back to
  the environment (`VECTOR_NSEC`, `VECTOR_PRIVATE_KEY`, `NOSTR_PRIVATE_KEY`,
  `NSEC`, or a seed phrase in `VECTOR_MNEMONIC` / `NOSTR_MNEMONIC`) when it does
  not, so the same code runs from a working copy and from a container with no
  writable disk. With `create: true` it mints and saves one instead of failing,
  which is the keyless mode: nothing to configure on the first run.

- **Friends.** `client.addFriend()`, `removeFriend()` and `getFriends()` manage
  the bot's NIP-02 contact list. Each change re-fetches the published list before
  republishing it, so a restart or a second client cannot drop everyone else.

- **Invites.** Community invite bundles (kind 3304) are parsed as they arrive and
  surfaced on the `invite` event, with expired ones flagged rather than dropped.
  `client.forwardInvite()` passes one the bot holds on to someone else, preserving
  the original NIP-40 expiry. A bot cannot *create* an invite: the bundle carries
  live community key material that only a member holding that community's state
  can produce. Bundles are treated as untrusted input and bounded on read, matching
  `vector_core::community::invite`.

- **`channel.sendRumor()`** gift-wraps and sends a rumor you built yourself, for
  event kinds with no dedicated method.

## [1.1.1] - 2026-09-23

Release plumbing only. No changes to the SDK itself.

### Fixed

- The publish job declared no GitHub Actions environment, so the OIDC token
  could not match the `Node.js Package NPMJS` environment recorded on the
  package's npm trusted publisher, and a trusted publish would have been
  rejected.

### Changed

- npm publishes through trusted publishing (OIDC) rather than a long-lived
  token. npm falls back to `NODE_AUTH_TOKEN` if OIDC is unavailable, so both
  routes work. Publishing with a token that requires two-factor authentication
  fails in CI with `EOTP`, which no automated run can answer; OIDC sidesteps it
  and, per npm's July 2026 notice, is the route that survives the January 2027
  restriction on 2FA-bypass tokens.
- The publish runner moved to Node 22 and upgrades npm, meeting the Node
  >= 22.14 and npm >= 11.5.1 floors trusted publishing requires.
- Both publish workflows check the registry first and skip a version already
  published, so a re-run is a no-op rather than a 409, and both accept
  `workflow_dispatch` so a failed publish can be retried without recreating the
  release.

## [1.1.0] - 2026-09-23

Catches the package up with VectorApp, whose Rust SDK was rewritten as
`crates/vector-sdk` 0.9.0 on top of `vector-core`. Several things the package
sent were no longer what Vector reads.

### Fixed

- File sends never reached Vector. Kind 15 attachments were published as plain
  signed events, but Vector only reads a kind 15 as a gift-wrapped rumor, so
  every file this SDK sent was invisible to it. Files now travel wrapped,
  exactly like text messages.
- Gift wraps ignored the recipient's inbox. Sends went to the bot's own relays
  only. They now resolve the recipient's NIP-17 kind 10050 relay list and
  deliver there, falling back to the bot's relays when a pubkey publishes none.
  The bot also publishes its own 10050 on connect, so other clients can route to
  it. Disable with `useInboxRelays: false`.
- Image metadata used the wrong hash. Vector moved from BlurHash to ThumbHash, so
  a `blurhash` tag is no longer part of the protocol. `ImageMetadata.blurhash` is
  now `ImageMetadata.thumbhash` (base91).

### Added

- Slash commands and the Bot Interface Manifest (kind 10304). Declare commands
  with typed arguments and the manifest publishes on connect, so every Vector
  client renders a `/` picker with a field per argument and validates input
  before it is sent. A matched invocation runs its handler and is consumed — it
  never reaches the `message` event. Argument types: `.string()`, `.int()`,
  `.number()`, `.flag()`, `.user()`, `.choice()`; read them off the context with
  `ctx.str/int/number/flag(name)`. The parser, validator and canonical error
  strings are ported from `vector_core::bot_interface` and verified against that
  crate's own test vectors (`npm test`).
- Commands answer publicly or privately. `ctx.reply()` answers where the command
  was invoked, `ctx.replyPrivately()` DMs the invoker even when the command came
  from a group, and `ctx.dm(user, text)` messages anyone, which pairs with a
  `.user()` argument.
- Bot addressing. `["bot", <hex>]` tags route an invocation to specific bots, so
  two bots can share a command name. Untagged is broadcast, so the tag is never
  required. Surfaced as `tags.addressedBots`.
- Message edits (kind 16) via `channel.edit(id, text)` and
  `client.editMessage(...)`. An edit is its own event referencing the original,
  matching Vector's event-sourced model.
- Message deletion (NIP-09) via `channel.delete(id)` and
  `client.deleteMessage(...)`.
- Threaded replies via `channel.reply(id, text)` and `client.replyTo(...)`,
  emitting the `["e", id, "", "reply"]` tag form Vector reads.
- NIP-40 self-destruct: pass `expiration` (Unix seconds) to any send. It is
  stamped on the rumor and mirrored onto the outer wrap, so relays purge the
  envelope on schedule rather than holding it.
- NIP-30 custom emoji: pass `emoji: [[shortcode, url], ...]` to a send, or
  `emojiUrl` to `react()` with a `:shortcode:`.
- Self-wrapping. Every outgoing message is also wrapped to the bot itself, so the
  account's other devices see what this one sent. Disable with `selfWrap: false`.
- Receiving attachments: `parseAttachment()`, plus `downloadAttachment()` and
  `saveAttachment()` on the bot and client, with `decryptData()` for AES-256-GCM
  payloads.
- New events: `attachment`, `message_update`, `reaction`, `message_delete`,
  `typing`, `command` and `manifest_published`. `ready` now reports the
  registered command count.
- Message ids. Sends return `{ id, sent }`, where the id is the rumor id that
  replies, edits, reactions and deletions reference. Incoming messages carry
  `tags.messageId` and `tags.replyTo`.
- Event kind constants (the `kinds` export), including the Concord v2 community
  block (3300-3311) for identification and filtering.
- A test suite (`npm test`) running the `vector_core::bot_interface` vectors
  against this package's port.

### Changed

- NIP-04 (kind 4) DMs are off by default, because Vector dropped NIP-04 entirely
  and ignores kind 4. Re-enable with `legacyNip04: true` to reach a client that
  still speaks it.
- The Concord v2 community protocol (kinds 3300-3311) is not implemented here.
  Its encrypted envelopes, epoch keys, consensus folding and rekeys live in
  `vector-core` and are not portable to this package at a sensible cost. The
  existing MLS sidecar path (kinds 443/444, via `mlsAdapter`) is unchanged and
  still works, and the v2 kind constants are exported so consumers can recognise
  the traffic.
- Release notes are now drafted by Release Drafter, and the publish workflows
  build, test and publish without rewriting the release body.

### Deprecated

- `sendPrivateMessage`, `sendReaction`, `sendTypingIndicator` and
  `sendPrivateFile` still work and still return booleans, but are superseded by
  `send`, `react`, `typing` and `sendFile`, which return the message id.

## [1.0.5] - 2026-02-14

Never tagged or published; superseded by 1.1.0.

### Added

- MLS sidecar adapter (`createMlsSidecarAdapter`) bridging the client to the
  Rust sidecar for Vector private groups: key-package publishing, welcome sync
  and processing, group-wrapper decryption and group sends.
- Group discovery from gift-wrap and wrapper history at startup, with
  `group_discovered`, `group_bootstrap_complete` and MLS diagnostic events.

### Changed

- Shipped the built `dist/` output in the repository.

## [1.0.4] - 2026-02-13

### Added

- `vectorOnly` mode matching VectorApp's relay filters, group command routing
  (`tags.botInGroup`, `tags.directedToBot`) and relay reconnection with
  `disconnect` / `reconnect` events.

### Fixed

- Key handling and normalization in `keys.ts`; attachment and client fixes.

## [1.0.3] - 2026-02-13

### Fixed

- Build failure in the publish workflows.

## [1.0.2] - 2026-01-20

### Changed

- Package version and documented dependency usage.

## [1.0.1] - 2026-01-20

### Changed

- Package version and README dependency references.

## [1.0.0] - 2026-01-20

### Added

- First stable release: project metadata, npm and GitHub Packages publish
  workflows, and this changelog.

## [0.2.1] - 2026-01-20

### Added

- Initial working SDK: Nostr client, key normalization, gift-wrap subscription,
  metadata builders, AES-256-GCM file encryption, NIP-96 upload, and the
  `VectorBotClient` / `VectorBot` / `Channel` surface, with a demo script.

[unreleased]: https://github.com/NekoSuneProjectsNPM/vector-sdk-js/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/NekoSuneProjectsNPM/vector-sdk-js/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/NekoSuneProjectsNPM/vector-sdk-js/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.4...v1.1.0
[1.0.5]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/NekoSuneProjects/vector-sdk-js/releases/tag/v1.0.0
