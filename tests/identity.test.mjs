// Account creation, safe storage, env fallback, contacts and invites.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  accountFromKey,
  accountFromMnemonic,
  ensureAccountIgnored,
  generateAccount,
  loadAccount,
  resolveAccount,
  saveAccount,
  publicAccountInfo,
} from '../dist/identity.js';
import { contactTags, parseContactList } from '../dist/contacts.js';
import {
  buildInviteRumor,
  parseCommunityInvite,
  readInviteRumor,
  MAX_INVITE_RELAYS,
} from '../dist/invites.js';
import {
  COMMUNITY_DIRECT_INVITE,
  COMMUNITY_INVITE_BUNDLE,
  CONTACT_LIST,
} from '../dist/kinds.js';
import {
  CommunityManager,
  CommunityStore,
  communityFromInvite,
  InviteRejected,
} from '../dist/communities.js';
import { parseProfile, User } from '../dist/users.js';
import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

let tmp;

// ── identity ─────────────────────────────────────────────────────────────────

test('a generated account is internally consistent', () => {
  const a = generateAccount();
  assert.equal(nip19.decode(a.npub).data, a.publicKey, 'npub decodes to the hex pubkey');
  assert.equal(
    Buffer.from(nip19.decode(a.nsec).data).toString('hex'),
    a.privateKey,
    'nsec decodes to the hex private key',
  );
  assert.equal(
    getPublicKey(nip19.decode(a.nsec).data),
    a.publicKey,
    'the public key really derives from the private key',
  );
  assert.ok(!a.mnemonic, 'no seed phrase unless asked for');
});

test('a seed phrase regenerates exactly the same key', () => {
  const a = generateAccount({ withMnemonic: true });
  assert.ok(a.mnemonic, 'a seed phrase is produced');
  assert.equal(a.mnemonic.split(' ').length, 12, 'twelve words');

  const restored = accountFromMnemonic(a.mnemonic);
  assert.equal(restored.privateKey, a.privateKey, 'same private key');
  assert.equal(restored.npub, a.npub, 'same npub');
});

test('a bad seed phrase is refused', () => {
  assert.throws(() => accountFromMnemonic('not actually a valid bip39 phrase at all here'));
});

test('an account round-trips through a file', async () => {
  const file = path.join(tmp, 'acct.json');
  const a = generateAccount({ withMnemonic: true });
  const saved = await saveAccount(a, file);

  const back = await loadAccount(saved);
  assert.equal(back.privateKey, a.privateKey);
  assert.equal(back.npub, a.npub);
  assert.equal(back.mnemonic, a.mnemonic, 'the seed phrase survives');
  assert.equal(back.createdAt, a.createdAt, 'the creation time survives');
});

test('loading rebuilds from the key, so a doctored file cannot lie', async () => {
  const file = path.join(tmp, 'tampered.json');
  const a = generateAccount();
  await saveAccount(a, file);

  // Swap in someone else's npub and pubkey, keeping the real private key.
  const other = generateAccount();
  const doctored = { ...a, npub: other.npub, publicKey: other.publicKey };
  await fs.writeFile(file, JSON.stringify(doctored, null, 2));

  const back = await loadAccount(file);
  assert.equal(back.npub, a.npub, 'the npub is re-derived, not trusted');
  assert.equal(back.publicKey, a.publicKey);
});

test('an account file with no key is rejected', async () => {
  const file = path.join(tmp, 'empty.json');
  await fs.writeFile(file, JSON.stringify({ npub: 'npub1whatever' }));
  await assert.rejects(() => loadAccount(file), /no private key/i);
});

test('public info carries nothing secret', () => {
  const a = generateAccount({ withMnemonic: true });
  const info = publicAccountInfo(a);
  const serialized = JSON.stringify(info);
  assert.ok(!serialized.includes(a.privateKey), 'no hex private key');
  assert.ok(!serialized.includes(a.nsec), 'no nsec');
  assert.ok(!serialized.includes(a.mnemonic), 'no seed phrase');
  assert.equal(info.npub, a.npub);
});

// ── keeping the key out of git ───────────────────────────────────────────────

test('the account file is added to .gitignore, once', async () => {
  const project = path.join(tmp, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), '{"name":"p"}');
  await fs.writeFile(path.join(project, '.gitignore'), 'node_modules/\n');

  const file = path.join(project, 'vector-bot-account.json');
  await saveAccount(generateAccount(), file);

  const first = await ensureAccountIgnored(file, { projectRoot: project });
  assert.deepEqual(first.updated.map((p) => path.basename(p)), ['.gitignore']);
  assert.equal(first.pattern, 'vector-bot-account.json');

  const second = await ensureAccountIgnored(file, { projectRoot: project });
  assert.equal(second.updated.length, 0, 'a second run changes nothing');
  assert.equal(second.alreadyIgnored.length, 1);

  const contents = await fs.readFile(path.join(project, '.gitignore'), 'utf8');
  const hits = contents.split('\n').filter((l) => l.trim() === 'vector-bot-account.json');
  assert.equal(hits.length, 1, 'exactly one entry, never duplicated');
  assert.ok(contents.includes('node_modules/'), 'existing entries are preserved');
});

test('.gitignore is created when the project has none', async () => {
  const project = path.join(tmp, 'bare');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), '{"name":"p"}');

  const file = path.join(project, 'vector-bot-account.json');
  await saveAccount(generateAccount(), file);
  const res = await ensureAccountIgnored(file, { projectRoot: project });

  assert.equal(res.updated.length, 1);
  const contents = await fs.readFile(path.join(project, '.gitignore'), 'utf8');
  assert.ok(contents.includes('vector-bot-account.json'));
});

test('.npmignore is only touched when the project already has one', async () => {
  const withOut = path.join(tmp, 'no-npmignore');
  await fs.mkdir(withOut, { recursive: true });
  await fs.writeFile(path.join(withOut, 'package.json'), '{"name":"p"}');
  await saveAccount(generateAccount(), path.join(withOut, 'vector-bot-account.json'));
  await ensureAccountIgnored(path.join(withOut, 'vector-bot-account.json'), {
    projectRoot: withOut,
  });
  // Creating one would switch npm off .gitignore and change what ships.
  await assert.rejects(() => fs.access(path.join(withOut, '.npmignore')));
});

// ── resolution order: file, then environment ─────────────────────────────────

test('the account file wins when it exists', async () => {
  const dir = path.join(tmp, 'resolve-file');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'acct.json');
  const onDisk = generateAccount();
  await saveAccount(onDisk, file);

  const fromEnv = generateAccount();
  const resolved = await resolveAccount({
    file,
    env: { VECTOR_NSEC: fromEnv.nsec },
  });

  assert.equal(resolved.source, 'file');
  assert.equal(resolved.account.npub, onDisk.npub, 'the file beats the environment');
});

test('the environment is used when there is no file', async () => {
  const fromEnv = generateAccount();
  const resolved = await resolveAccount({
    file: path.join(tmp, 'does-not-exist.json'),
    env: { VECTOR_NSEC: fromEnv.nsec },
  });

  assert.equal(resolved.source, 'env');
  assert.equal(resolved.envVar, 'VECTOR_NSEC');
  assert.equal(resolved.account.npub, fromEnv.npub);
});

test('a seed phrase in the environment works too', async () => {
  const seeded = generateAccount({ withMnemonic: true });
  const resolved = await resolveAccount({
    file: path.join(tmp, 'nope.json'),
    env: { VECTOR_MNEMONIC: seeded.mnemonic },
  });
  assert.equal(resolved.source, 'env');
  assert.equal(resolved.account.npub, seeded.npub);
});

test('env vars are tried in order', async () => {
  const first = generateAccount();
  const second = generateAccount();
  const resolved = await resolveAccount({
    file: path.join(tmp, 'nope2.json'),
    env: { NOSTR_PRIVATE_KEY: second.privateKey, VECTOR_NSEC: first.nsec },
  });
  assert.equal(resolved.account.npub, first.npub, 'VECTOR_NSEC is checked first');
});

test('with nothing anywhere it explains where it looked', async () => {
  await assert.rejects(
    () => resolveAccount({ file: path.join(tmp, 'absent.json'), env: {} }),
    /No account found.*VECTOR_NSEC/s,
  );
});

test('create: true mints and saves an account', async () => {
  const dir = path.join(tmp, 'keyless');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'acct.json');

  const first = await resolveAccount({ file, env: {}, create: true, protect: false });
  assert.equal(first.source, 'created');

  // The whole point of keyless mode: the next run is the same bot.
  const second = await resolveAccount({ file, env: {}, create: true, protect: false });
  assert.equal(second.source, 'file');
  assert.equal(second.account.npub, first.account.npub, 'identity is stable across runs');
});

test('a hex private key from the environment is accepted', async () => {
  const a = generateAccount();
  const resolved = await resolveAccount({
    file: path.join(tmp, 'none.json'),
    env: { VECTOR_PRIVATE_KEY: a.privateKey },
  });
  assert.equal(resolved.account.npub, a.npub);
});

test('accountFromKey takes both nsec and hex', () => {
  const a = generateAccount();
  assert.equal(accountFromKey(a.nsec).npub, a.npub);
  assert.equal(accountFromKey(a.privateKey).npub, a.npub);
});

// ── contacts (NIP-02) ────────────────────────────────────────────────────────

test('contacts round-trip through their tags', () => {
  const a = generateAccount();
  const b = generateAccount();
  const contacts = [
    { pubkey: a.publicKey, npub: a.npub },
    { pubkey: b.publicKey, npub: b.npub, relay: 'wss://relay.example', petname: 'owner' },
  ];

  const tags = contactTags(contacts);
  assert.deepEqual(tags[0], ['p', a.publicKey]);
  assert.deepEqual(tags[1], ['p', b.publicKey, 'wss://relay.example', 'owner']);

  const back = parseContactList({ kind: CONTACT_LIST, tags, content: '' });
  assert.equal(back.length, 2);
  assert.equal(back[1].petname, 'owner');
  assert.equal(back[1].npub, b.npub);
});

test('a petname with no relay still parses back correctly', () => {
  const a = generateAccount();
  const tags = contactTags([{ pubkey: a.publicKey, npub: a.npub, petname: 'boss' }]);
  // The relay slot must be held open, or the petname reads as the relay.
  assert.deepEqual(tags[0], ['p', a.publicKey, '', 'boss']);
  const back = parseContactList({ kind: CONTACT_LIST, tags, content: '' });
  assert.equal(back[0].petname, 'boss');
  assert.equal(back[0].relay, undefined);
});

test('a contact list drops duplicates and junk without dying', () => {
  const a = generateAccount();
  const back = parseContactList({
    kind: CONTACT_LIST,
    content: '',
    tags: [
      ['p', a.publicKey],
      ['p', a.publicKey],
      ['p', 'not-a-pubkey'],
      ['e', 'wrong tag'],
    ],
  });
  assert.equal(back.length, 1);
});

test('a non-contact-list event yields nothing', () => {
  assert.deepEqual(parseContactList({ kind: 1, tags: [['p', 'x']], content: '' }), []);
  assert.deepEqual(parseContactList(null), []);
});

// ── invites ──────────────────────────────────────────────────────────────────

// A v1 bundle: server_root_key / server_root_epoch.
const bundle = (over = {}) =>
  JSON.stringify({
    community_id: 'comm-123',
    name: 'Test Community',
    server_root_key: 'deadbeef'.repeat(4),
    server_root_epoch: 3,
    relays: ['wss://a.example', 'wss://b.example'],
    channels: [{ id: 'chan-1', name: 'general', epoch: 2 }],
    ...over,
  });

// A v2 bundle, in the wire-frozen shape a live Vector client actually sends:
// community_root / root_epoch, an owner that the id self-certifies from, and
// channel grants carrying their own keys.
const v2Bundle = (over = {}) =>
  JSON.stringify({
    community_id: '248af5b6'.repeat(8),
    owner: 'b5a263b1'.repeat(8),
    owner_salt: 'aabbccdd'.repeat(8),
    community_root: '11223344'.repeat(8),
    root_epoch: 0,
    control_pk: 'ccddeeff'.repeat(8),
    name: 'NekoSune Community',
    relays: ['wss://jskitty.cat/nostr', 'wss://relay.damus.io', 'wss://nos.lol'],
    channels: [{ id: 'ch'.repeat(32), key: 'kk'.repeat(32), epoch: 0, name: 'general' }],
    expires_at: Date.now() + 3600_000,
    ...over,
  });

test('a well-formed invite parses', () => {
  const invite = parseCommunityInvite({
    kind: COMMUNITY_INVITE_BUNDLE,
    content: bundle(),
  });
  assert.ok(invite);
  assert.equal(invite.communityId, 'comm-123');
  assert.equal(invite.name, 'Test Community');
  assert.equal(invite.epoch, 3);
  assert.equal(invite.protocol, 'v1');
  assert.equal(invite.relays.length, 2);
  assert.equal(invite.channels[0].name, 'general');
});

test('a non-invite kind or malformed bundle yields null, never a throw', () => {
  assert.equal(parseCommunityInvite({ kind: 14, content: bundle() }), null);
  assert.equal(parseCommunityInvite({ kind: COMMUNITY_INVITE_BUNDLE, content: 'nonsense' }), null);
  assert.equal(parseCommunityInvite({ kind: COMMUNITY_INVITE_BUNDLE, content: '' }), null);
  // No key material means the bundle grants nothing.
  assert.equal(
    parseCommunityInvite({
      kind: COMMUNITY_INVITE_BUNDLE,
      content: JSON.stringify({ community_id: 'x' }),
    }),
    null,
  );
});

test('a real v2 bundle (kind 3313) parses', () => {
  const invite = parseCommunityInvite({
    kind: COMMUNITY_DIRECT_INVITE,
    content: v2Bundle(),
  });
  assert.ok(invite, 'the shape a live Vector client sends must parse');
  assert.equal(invite.protocol, 'v2');
  assert.equal(invite.name, 'NekoSune Community');
  // v2 names the access key community_root, not server_root_key.
  assert.equal(invite.accessKey, '11223344'.repeat(8));
  assert.equal(invite.epoch, 0);
  assert.equal(invite.owner, 'b5a263b1'.repeat(8));
  assert.ok(invite.ownerSalt, 'the salt the community id certifies from');
  assert.ok(invite.controlPk);
  assert.equal(invite.channels.length, 1);
  assert.ok(invite.channels[0].key, 'a channel grant carries its key');
  assert.ok(invite.expiresAtMs > Date.now(), 'the bundle states its own deadline in ms');
});

test('a v2 bundle read as v1 fails, and vice versa', () => {
  // The field names are wire-frozen and differ between generations, so reading
  // one shape with the other rules must not half-succeed.
  assert.equal(
    parseCommunityInvite({ kind: COMMUNITY_INVITE_BUNDLE, content: v2Bundle() }),
    null,
  );
  assert.equal(
    parseCommunityInvite({ kind: COMMUNITY_DIRECT_INVITE, content: bundle() }),
    null,
  );
});

test('a v2 bundle with no channels still parses', () => {
  // armada omits `channels` when the bundle vends no keys; a required list
  // would turn a keyless invite into a join failure.
  const invite = parseCommunityInvite({
    kind: COMMUNITY_DIRECT_INVITE,
    content: v2Bundle({ channels: undefined }),
  });
  assert.ok(invite);
  assert.equal(invite.channels.length, 0);
});

test('a v2 invite takes its expiry from the bundle when the wrap has no tag', () => {
  const now = Math.floor(Date.now() / 1000);
  const received = readInviteRumor(
    {
      kind: COMMUNITY_DIRECT_INVITE,
      content: v2Bundle({ expires_at: (now + 600) * 1000 }),
      tags: [],
      pubkey: 'ab'.repeat(32),
    },
    now,
  );
  assert.equal(received.expiresAt, now + 600, 'ms in the bundle become seconds');
  assert.equal(received.expired, false);
});

test('forwarding a v2 invite keeps kind 3313', () => {
  const invite = parseCommunityInvite({
    kind: COMMUNITY_DIRECT_INVITE,
    content: v2Bundle(),
  });
  assert.equal(buildInviteRumor(invite).kind, COMMUNITY_DIRECT_INVITE);
});

test('a hostile relay list is capped', () => {
  const many = Array.from({ length: 50 }, (_, i) => `wss://r${i}.example`);
  const invite = parseCommunityInvite({
    kind: COMMUNITY_INVITE_BUNDLE,
    content: bundle({ relays: many }),
  });
  assert.equal(invite.relays.length, MAX_INVITE_RELAYS);
});

test('an expired invite is returned but flagged', () => {
  const now = 1_000_000;
  const expired = readInviteRumor(
    {
      kind: COMMUNITY_INVITE_BUNDLE,
      content: bundle(),
      tags: [['expiration', String(now - 1)]],
      pubkey: 'ab'.repeat(32),
      id: 'cd'.repeat(32),
    },
    now,
  );
  assert.ok(expired, 'still surfaced — dropping it would look like it never arrived');
  assert.equal(expired.expired, true);

  const live = readInviteRumor(
    {
      kind: COMMUNITY_INVITE_BUNDLE,
      content: bundle(),
      tags: [['expiration', String(now + 3600)]],
      pubkey: 'ab'.repeat(32),
    },
    now,
  );
  assert.equal(live.expired, false);
  assert.equal(live.expiresAt, now + 3600);
});

test('forwarding re-sends the bundle verbatim and cannot extend its life', () => {
  const invite = parseCommunityInvite({
    kind: COMMUNITY_INVITE_BUNDLE,
    content: bundle(),
  });
  const deadline = Math.floor(Date.now() / 1000) + 60;
  const rumor = buildInviteRumor(invite, { expiresAt: deadline });

  assert.equal(rumor.kind, COMMUNITY_INVITE_BUNDLE);
  assert.deepEqual(rumor.tags[0], ['expiration', String(deadline)]);
  // The bundle is the community's key material, not ours to rewrite.
  assert.deepEqual(JSON.parse(rumor.content), JSON.parse(bundle()));
});

// ── accepting invites ────────────────────────────────────────────────────────

test('accepting an invite keeps the vended keys', async () => {
  const invite = parseCommunityInvite({ kind: COMMUNITY_DIRECT_INVITE, content: v2Bundle() });
  const store = new CommunityStore(path.join(tmp, 'communities.json'));

  const joined = communityFromInvite(invite, { invitedBy: 'ab'.repeat(32) });
  await store.put(joined);

  const back = await store.get(invite.communityId);
  assert.ok(back);
  assert.equal(back.accessKey, invite.accessKey, 'the access key is what makes it useful later');
  assert.equal(back.channels[0].key, invite.channels[0].key, 'channel grants are kept');
  assert.equal(back.protocol, 'v2');
  assert.equal(back.announced, false, 'not announced — that needs the v2 stream layer');
});

test('re-accepting replaces the entry rather than duplicating it', async () => {
  const store = new CommunityStore(path.join(tmp, 'rejoin.json'));
  const first = parseCommunityInvite({ kind: COMMUNITY_DIRECT_INVITE, content: v2Bundle() });
  await store.put(communityFromInvite(first, { invitedBy: 'ab'.repeat(32) }));

  // A later invite carrying a rotated key for the same community.
  const rotated = parseCommunityInvite({
    kind: COMMUNITY_DIRECT_INVITE,
    content: v2Bundle({ community_root: '99887766'.repeat(8), root_epoch: 4 }),
  });
  await store.put(communityFromInvite(rotated, { invitedBy: 'ab'.repeat(32) }));

  const all = await store.all();
  assert.equal(all.length, 1, 'one entry per community');
  assert.equal(all[0].accessKey, '99887766'.repeat(8), 'the rotated key wins');
  assert.equal(all[0].epoch, 4);
});

test('an expired invite is refused', () => {
  const invite = parseCommunityInvite({ kind: COMMUNITY_DIRECT_INVITE, content: v2Bundle() });
  const now = Math.floor(Date.now() / 1000);
  assert.throws(
    () => communityFromInvite(invite, { invitedBy: 'x', expiresAt: now - 1, now }),
    (e) => e instanceof InviteRejected && e.reason === 'expired',
  );
});

test('leaving discards the keys', async () => {
  const store = new CommunityStore(path.join(tmp, 'leave.json'));
  const invite = parseCommunityInvite({ kind: COMMUNITY_DIRECT_INVITE, content: v2Bundle() });
  await store.put(communityFromInvite(invite, { invitedBy: 'ab'.repeat(32) }));

  assert.equal(await store.remove(invite.communityId), true);
  assert.equal(await store.has(invite.communityId), false);
  assert.equal(await store.remove(invite.communityId), false, 'removing twice is not an error');
});

test('a corrupt store reads as empty rather than throwing', async () => {
  const file = path.join(tmp, 'corrupt.json');
  await fs.writeFile(file, 'not json at all');
  const store = new CommunityStore(file);
  assert.deepEqual(await store.all(), [], 'a bot must still start');
});

// ── users and members ────────────────────────────────────────────────────────

test('a profile parses, including both display-name spellings', () => {
  const a = parseProfile({
    kind: 0,
    content: JSON.stringify({ name: 'neko', display_name: 'NekoSune', about: 'hi', bot: true }),
  });
  assert.equal(a.name, 'neko');
  assert.equal(a.displayName, 'NekoSune');
  assert.equal(a.bot, true);

  // Clients have written both spellings for years.
  const b = parseProfile({ kind: 0, content: JSON.stringify({ displayName: 'Camel' }) });
  assert.equal(b.displayName, 'Camel');
});

test('a malformed or non-profile event yields empty fields, never a throw', () => {
  assert.deepEqual(parseProfile({ kind: 0, content: 'not json' }), {});
  assert.deepEqual(parseProfile({ kind: 1, content: '{"name":"x"}' }), {});
  assert.deepEqual(parseProfile(null), {});
});

test('a user always has something to display', () => {
  const account = generateAccount();
  const anonymous = new User(account.publicKey, {}, { client: {} });
  assert.ok(anonymous.displayName.length > 0, 'falls back to a short npub');
  assert.equal(anonymous.known, false, 'no profile was ever found');
  assert.equal(anonymous.npub, account.npub);

  const named = new User(account.publicKey, { displayName: 'Bot' }, { client: {} }, Date.now());
  assert.equal(named.displayName, 'Bot');
  assert.equal(named.known, true);
});

test('members list the owner and inviter, deduped, and say they are incomplete', async () => {
  const owner = generateAccount();
  const inviter = generateAccount();
  const observer = generateAccount();

  const store = new CommunityStore(path.join(tmp, 'members.json'));
  const invite = parseCommunityInvite({
    kind: COMMUNITY_DIRECT_INVITE,
    content: v2Bundle({ owner: owner.publicKey }),
  });
  await store.put(communityFromInvite(invite, { invitedBy: inviter.publicKey }));

  const manager = new CommunityManager(store);
  const community = (await manager.fetch()).first();

  // The real roster is in the sealed Guestbook, which needs the v2 stream layer.
  assert.equal(community.members.complete, false, 'must not read as the whole community');
  assert.equal(community.members.ownerId, owner.publicKey);

  let members = community.members.list();
  assert.equal(members.length, 2, 'owner + inviter');
  assert.equal(members.find((m) => m.isOwner).pubkey, owner.publicKey);
  assert.equal(members.find((m) => m.source === 'inviter').pubkey, inviter.publicKey);

  community.members.observe(observer.publicKey);
  assert.equal(community.members.size, 3);

  // Observing the owner or inviter again must not duplicate them.
  community.members.observe(owner.publicKey);
  community.members.observe(inviter.publicKey);
  assert.equal(community.members.size, 3, 'no duplicates');
});

test('when the owner invited you, they are one member not two', async () => {
  const owner = generateAccount();
  const store = new CommunityStore(path.join(tmp, 'selfinvite.json'));
  const invite = parseCommunityInvite({
    kind: COMMUNITY_DIRECT_INVITE,
    content: v2Bundle({ owner: owner.publicKey }),
  });
  await store.put(communityFromInvite(invite, { invitedBy: owner.publicKey }));

  const community = (await new CommunityManager(store).fetch()).first();
  const members = community.members.list();
  assert.equal(members.length, 1, 'the same person twice is one member');
  assert.equal(members[0].isOwner, true);
});

// ── runner ───────────────────────────────────────────────────────────────────

console.log('\nidentity / contacts / invites');
tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vector-sdk-test-'));
try {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (error) {
      console.log(`  FAIL ${name}\n       ${error.message}`);
      process.exitCode = 1;
    }
  }
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log(`\n${passed}/${tests.length} passed${process.exitCode ? ', FAILURES above' : ''}\n`);
