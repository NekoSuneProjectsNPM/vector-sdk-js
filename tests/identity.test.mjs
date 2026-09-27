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
import { COMMUNITY_INVITE_BUNDLE, CONTACT_LIST } from '../dist/kinds.js';
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

test('a well-formed invite parses', () => {
  const invite = parseCommunityInvite({
    kind: COMMUNITY_INVITE_BUNDLE,
    content: bundle(),
  });
  assert.ok(invite);
  assert.equal(invite.communityId, 'comm-123');
  assert.equal(invite.name, 'Test Community');
  assert.equal(invite.serverRootEpoch, 3);
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
