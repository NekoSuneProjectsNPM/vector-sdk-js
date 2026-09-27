# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are drafted by [Release Drafter](.github/release-drafter.yml) from
merged pull requests; this file is the curated, hand-written record of what
changed in each version.

## [Unreleased]

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

[unreleased]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.4...v1.1.0
[1.0.5]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/NekoSuneProjects/vector-sdk-js/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/NekoSuneProjects/vector-sdk-js/releases/tag/v1.0.0
