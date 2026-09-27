// Concord v2: frozen derivations, the stream envelope, chat and guestbook, and
// the runtime that turns relay traffic into community events.
import assert from 'node:assert/strict';
import { bytesToHex } from '@noble/hashes/utils';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip44 } from 'nostr-tools';

import * as d from '../dist/concord/derive.js';
import * as s from '../dist/concord/stream.js';
import * as chat from '../dist/concord/chat.js';
import * as gb from '../dist/concord/guestbook.js';
import { CommunityRuntime, resolveChannels } from '../dist/concord/runtime.js';
import { communityFromInvite } from '../dist/communities.js';
import * as att from '../dist/concord/attachments.js';
import { encryptData, generateEncryptionParams, calculateFileHash } from '../dist/crypto.js';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const keypair = () => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
};

// Fixed inputs from vector-core's derive.rs test module.
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i);
const ID32 = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const ALT = new Uint8Array(32).fill(0x11);
const EPOCH_MULTI = 0x0102030405060708n;

// ── golden vectors (minted by an independent implementation upstream) ───────

test('channel key: HKDF seed and x-only pubkey match the golden vector', () => {
  const key = d.channelGroupKey(SECRET, ID32, 0);
  assert.equal(bytesToHex(key.sk), '1a99a5958bf9fcc5336e6e19db42aabf36ffbfa12f38a1d5fbde2ae383ed751b');
  assert.equal(key.pk, '7a5c5dff759a63f1fc2779864487432bae3d1ea72c4ffabd39f4c1fdaf62097a');
});

test('epoch is encoded big-endian', () => {
  assert.equal(d.channelGroupKey(SECRET, ID32, EPOCH_MULTI).pk, 'f20c7d192cc87615d7341e86f38f85303f4708b40232d4fea521ab8217767391');
});

test('control, control-signer and guestbook keys match the golden vectors', () => {
  assert.equal(d.controlGroupKey(SECRET, ID32, 0).pk, 'c43df20bf4d6eeaea5149619662ffe9b211f31e11bb4a59f56b6e906f702d46f');
  assert.equal(bytesToHex(d.controlSignerGroupKey(SECRET, ID32, 0).sk), 'c4a3e8354d95137132087356412b67b53e025d127d45de45cff9ecf45b0c24f6');
  assert.equal(d.controlSignerGroupKey(SECRET, ID32, 0).pk, '718aef388257f3fd9f1bfae5cf2cbd0594a2ffc31adb5c1fe22c502c046acaee');
  assert.equal(d.controlSignerGroupKey(SECRET, ID32, EPOCH_MULTI).pk, 'e27235cc13be2f9ad65648e01ff2b63402846469c8638b5386c625688194ec7d');
  assert.equal(d.guestbookGroupKey(SECRET, ID32, 0).pk, 'ad09de582026fa7a052db18bb5827fa24c15e929d59aadcc91efb8508f5368ad');
});

test('rekey and dissolved keys match the golden vectors', () => {
  assert.equal(d.channelRekeyGroupKey(SECRET, ID32, 1).pk, '7c55cdb957e9db2b4800d687b2a07d3f7066b1a35824a1e86ba871f55e87e8b5');
  assert.equal(d.baseRekeyGroupKey(SECRET, ID32, 1).pk, 'fb2fa44fba66ba15595f784255a1cb569531db8784432ac0e4fe838498dd9dea');
  assert.equal(d.dissolvedGroupKey(ID32).pk, '4d3d55d88fdf9d9c2089651e5cbb0dfa93b6b9b10cdcb2319b0dce1a1398096a');
});

test('community id and epoch commitment match the golden vectors', () => {
  assert.equal(bytesToHex(d.communityIdOf(SECRET, ALT)), '2b790bd59df98bdc52092b74ebd6933a89ef8eaeecc9030861cbdeae7c814c46');
  assert.equal(bytesToHex(d.epochKeyCommitment(2, SECRET)), '3e6d6a3c9973c16d1ca7c5602d36979927c55c21a7e2c840f883af3f047e80a4');
});

test('verifyCommunityId accepts the real owner and rejects any other', () => {
  const id = bytesToHex(d.communityIdOf(SECRET, ALT));
  assert.equal(d.verifyCommunityId(id, bytesToHex(SECRET), bytesToHex(ALT)), true);
  assert.equal(d.verifyCommunityId(id, bytesToHex(ALT), bytesToHex(ALT)), false);
  assert.equal(d.verifyCommunityId(id, 'not-hex', bytesToHex(ALT)), false);
});

// ── stream envelope ──────────────────────────────────────────────────────────

const CHANNEL = bytesToHex(ID32);
const group = d.channelGroupKey(SECRET, ID32, 0);

function postMessage(author, text, { channel = CHANNEL, epoch = 0, key = group } = {}) {
  const rumor = chat.buildMessageRumor(author.pk, channel, epoch, text);
  return { rumor, wrap: chat.sealChatRumor(rumor, key, author.sk) };
}

test('a chat message round-trips with its author, id and ms time', () => {
  const alice = keypair();
  const at = Date.UTC(2026, 8, 27, 12, 0, 0, 345);
  const rumor = chat.buildMessageRumor(alice.pk, CHANNEL, 0, 'hello', { atMs: at });
  const wrap = chat.sealChatRumor(rumor, group, alice.sk);

  assert.equal(wrap.kind, 1059);
  assert.equal(wrap.pubkey, group.pk);
  assert.equal(wrap.tags[0][0], 'p');

  const event = chat.openChatEvent(wrap, group, CHANNEL, 0);
  assert.equal(event.type, 'message');
  assert.equal(event.opened.author, alice.pk);
  assert.equal(event.opened.rumor.content, 'hello');
  assert.equal(event.opened.rumor.id, rumor.id);
  assert.equal(event.opened.atMs, at);
  assert.equal(event.opened.sealForm, 'encrypted');
});

test('a reply carries the quoted parent', () => {
  const alice = keypair();
  const parent = 'ab'.repeat(32);
  const rumor = chat.buildMessageRumor(alice.pk, CHANNEL, 0, 'yes', { replyTo: { id: parent, author: alice.pk } });
  const event = chat.openChatEvent(chat.sealChatRumor(rumor, group, alice.sk), group, CHANNEL, 0);
  assert.deepEqual(event.replyTo, { id: parent, author: alice.pk });
});

test('reactions, edits and deletes parse with their targets', () => {
  const alice = keypair();
  const target = { id: 'cd'.repeat(32), author: alice.pk };
  const reaction = chat.openChatEvent(chat.sealChatRumor(chat.buildReactionRumor(alice.pk, CHANNEL, 0, target, '👍'), group, alice.sk), group, CHANNEL, 0);
  assert.equal(reaction.type, 'reaction');
  assert.equal(reaction.target, target.id);
  assert.equal(reaction.emoji, '👍');

  const edit = chat.openChatEvent(chat.sealChatRumor(chat.buildEditRumor(alice.pk, CHANNEL, 0, target.id, 'fixed'), group, alice.sk), group, CHANNEL, 0);
  assert.equal(edit.type, 'edit');
  assert.equal(edit.newContent, 'fixed');

  const del = chat.openChatEvent(chat.sealChatRumor(chat.buildDeleteRumor(alice.pk, CHANNEL, 0, target.id), group, alice.sk), group, CHANNEL, 0);
  assert.equal(del.type, 'delete');
  assert.equal(del.targetKind, 9);
});

test('typing rides an ephemeral 21059 wrap', () => {
  const alice = keypair();
  const wrap = chat.sealChatRumor(chat.buildTypingRumor(alice.pk, CHANNEL, 0), group, alice.sk, { ephemeral: true });
  assert.equal(wrap.kind, 21059);
  assert.equal(chat.openChatEvent(wrap, group, CHANNEL, 0).type, 'typing');
});

test('a wrap from another stream is rejected', () => {
  const alice = keypair();
  const other = d.channelGroupKey(ALT, ID32, 0);
  const { wrap } = postMessage(alice, 'hi', { key: other });
  assert.throws(() => chat.openChatEvent(wrap, group, CHANNEL, 0), /wrong-stream/);
});

test('a message spliced from another channel or epoch is rejected', () => {
  const alice = keypair();
  const otherChannel = 'ee'.repeat(32);
  assert.throws(() => chat.openChatEvent(postMessage(alice, 'x', { channel: otherChannel }).wrap, group, CHANNEL, 0), /channel-mismatch/);
  assert.throws(() => chat.openChatEvent(postMessage(alice, 'x', { epoch: 1 }).wrap, group, CHANNEL, 0), /epoch-mismatch/);
});

/** Seal a hand-built rumor, so it can lie about its author or id. */
function forge(rumor, sealerSk) {
  const seal = finalizeEvent({ kind: 20013, created_at: rumor.created_at, tags: [], content: nip44.v2.encrypt(JSON.stringify(rumor), group.convKey) }, sealerSk);
  return s.wrapSeal(seal, group);
}

test('a rumor claiming someone other than its sealer is rejected', () => {
  const alice = keypair();
  const mallory = keypair();
  const rumor = chat.buildMessageRumor(alice.pk, CHANNEL, 0, 'I am alice');
  assert.throws(() => chat.openChatEvent(forge(rumor, mallory.sk), group, CHANNEL, 0), /author-mismatch/);
});

test('a rumor with a forged id is rejected', () => {
  const alice = keypair();
  const rumor = { ...chat.buildMessageRumor(alice.pk, CHANNEL, 0, 'hi'), id: '00'.repeat(32) };
  assert.throws(() => chat.openChatEvent(forge(rumor, alice.sk), group, CHANNEL, 0), /bad-rumor-id/);
});

test('a tampered seal signature is rejected', () => {
  const alice = keypair();
  const rumor = chat.buildMessageRumor(alice.pk, CHANNEL, 0, 'hi');
  const seal = s.buildSeal(rumor, 'encrypted', group, alice.sk);
  const tampered = { ...seal, sig: seal.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) };
  assert.throws(() => s.openWrap(s.wrapSeal(tampered, group), group), /bad-seal-signature/);
});

test('ms must be a lone 0..999 decimal without leading zeros', () => {
  const at = { created_at: 10, tags: [] };
  assert.equal(s.resolveMsStrict(at), 10_000);
  assert.equal(s.resolveMsStrict({ ...at, tags: [['ms', '7']] }), 10_007);
  for (const bad of ['1000', '07', '+5', '', 'x']) {
    assert.throws(() => s.resolveMsStrict({ ...at, tags: [['ms', bad]] }), /bad-ms/, bad);
  }
  assert.throws(() => s.resolveMsStrict({ ...at, tags: [['ms']] }), /bad-ms/);
});

test('a duplicated binding tag is rejected', () => {
  const alice = keypair();
  const base = { pubkey: alice.pk, created_at: 1, kind: 9, content: 'x', tags: [['channel', CHANNEL], ['channel', CHANNEL], ['epoch', '0']] };
  const rumor = { ...base, id: getEventHash(base) };
  assert.throws(() => chat.openChatEvent(forge(rumor, alice.sk), group, CHANNEL, 0), /duplicate-tag/);
});

// ── guestbook ────────────────────────────────────────────────────────────────

test('a guestbook join round-trips with its invite attribution', () => {
  const alice = keypair();
  const book = d.guestbookGroupKey(SECRET, ID32, 0);
  const rumor = gb.buildJoinRumor(alice.pk, { creator: 'aa'.repeat(32), label: 'friends' });
  const entry = gb.openGuestbookEvent(gb.sealGuestbookRumor(rumor, book, alice.sk), book);
  assert.equal(entry.type, 'join');
  assert.equal(entry.member, alice.pk);
  assert.deepEqual(entry.invitedBy, { creator: 'aa'.repeat(32), label: 'friends' });
  assert.equal(gb.openGuestbookEvent(gb.sealGuestbookRumor(gb.buildLeaveRumor(alice.pk), book, alice.sk), book).type, 'leave');
});

test('a guestbook entry with an unknown verb is rejected', () => {
  const alice = keypair();
  const book = d.guestbookGroupKey(SECRET, ID32, 0);
  const rumor = s.buildRumorMs(3306, alice.pk, 'hello', [], Date.now());
  assert.throws(() => gb.openGuestbookEvent(gb.sealGuestbookRumor(rumor, book, alice.sk), book), /bad-verb/);
});

// ── runtime ──────────────────────────────────────────────────────────────────

function fakeHost(bot, existingWraps = []) {
  const published = [];
  const events = [];
  const subs = [];
  const saved = [];
  const pool = {
    subscribe(relays, filter, handlers) {
      const sub = { filter, handlers, closed: false, close() { this.closed = true; } };
      subs.push(sub);
      return sub;
    },
    async querySync() {
      return existingWraps;
    },
  };
  return {
    host: {
      publicKey: bot.pk,
      privateKey: bot.sk,
      pool,
      publish: async (event, relays) => published.push({ event, relays }),
      save: async (record) => saved.push({ ...record }),
      emit: (name, payload) => events.push([name, payload]),
      log: () => {},
    },
    published,
    events,
    subs,
    saved,
    deliver: (wrap) => subs.forEach((sub) => !sub.closed && sub.handlers.onevent(wrap)),
  };
}

const owner = keypair();
const salt = bytesToHex(ALT);
const communityId = bytesToHex(d.communityIdOf(Uint8Array.from(Buffer.from(owner.pk, 'hex')), ALT));
const record = (overrides = {}) => ({
  communityId,
  name: 'Test Community',
  protocol: 'v2',
  accessKey: bytesToHex(SECRET),
  epoch: 0,
  owner: owner.pk,
  ownerSalt: salt,
  relays: ['wss://relay.example'],
  channels: [{ id: CHANNEL, name: 'general', epoch: 0 }],
  invitedBy: owner.pk,
  joinedAt: new Date().toISOString(),
  announced: false,
  ...overrides,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('public channels read under the community root at the root epoch', () => {
  const [channel] = resolveChannels(record());
  assert.equal(channel.group.pk, d.channelGroupKey(SECRET, ID32, 0).pk);
  assert.equal(channel.name, 'general');
});

test('the runtime subscribes to channel and guestbook addresses on the community relays', async () => {
  const bot = keypair();
  const h = fakeHost(bot);
  await new CommunityRuntime(h.host).start([record({ announced: true })]);
  assert.equal(h.subs.length, 1);
  assert.deepEqual(h.subs[0].filter.kinds, [1059, 21059]);
  assert.ok(h.subs[0].filter.authors.includes(group.pk));
  assert.ok(h.subs[0].filter.authors.includes(d.guestbookGroupKey(SECRET, Buffer.from(communityId, 'hex'), 0).pk));
});

test("another member's message arrives once as community_message, with a working reply", async () => {
  const bot = keypair();
  const alice = keypair();
  const h = fakeHost(bot);
  await new CommunityRuntime(h.host).start([record({ announced: true })]);

  const { wrap, rumor } = postMessage(alice, 'hi bot');
  h.deliver(wrap);
  h.deliver(wrap); // the same wrap from a second relay
  const messages = h.events.filter(([name]) => name === 'community_message');
  assert.equal(messages.length, 1);
  const [, message] = messages[0];
  assert.equal(message.content, 'hi bot');
  assert.equal(message.author, alice.pk);
  assert.equal(message.channelName, 'general');
  assert.equal(message.id, rumor.id);

  await message.reply('hello alice');
  const reply = chat.openChatEvent(h.published.at(-1).event, group, CHANNEL, 0);
  assert.equal(reply.opened.author, bot.pk);
  assert.deepEqual(reply.replyTo, { id: rumor.id, author: alice.pk });
  assert.deepEqual(h.published.at(-1).relays, ['wss://relay.example']);
});

test("the bot's own messages are not echoed back", async () => {
  const bot = keypair();
  const h = fakeHost(bot);
  await new CommunityRuntime(h.host).start([record({ announced: true })]);
  h.deliver(postMessage(bot, 'from me').wrap);
  assert.equal(h.events.filter(([name]) => name === 'community_message').length, 0);
});

test('a forged wrap is dropped, never surfaced', async () => {
  const bot = keypair();
  const alice = keypair();
  const mallory = keypair();
  const h = fakeHost(bot);
  await new CommunityRuntime(h.host).start([record({ announced: true })]);
  h.deliver(forge(chat.buildMessageRumor(alice.pk, CHANNEL, 0, 'fake'), mallory.sk));
  assert.equal(h.events.filter(([name]) => name === 'community_message').length, 0);
});

test('send works by channel name and rejects unknown channels', async () => {
  const bot = keypair();
  const h = fakeHost(bot);
  const runtime = new CommunityRuntime(h.host);
  await runtime.start([record({ announced: true })]);
  const result = await runtime.send(communityId, '#general', 'hello');
  assert.equal(chat.openChatEvent(h.published[0].event, group, CHANNEL, 0).opened.rumor.id, result.id);
  await assert.rejects(runtime.send(communityId, 'nope', 'x'), /No readable channel/);
});

test('a first join is announced once, with the inviter echoed', async () => {
  const bot = keypair();
  const h = fakeHost(bot);
  await new CommunityRuntime(h.host).start([record()]);
  await tick();
  assert.equal(h.published.length, 1);
  const book = d.guestbookGroupKey(SECRET, Buffer.from(communityId, 'hex'), 0);
  const entry = gb.openGuestbookEvent(h.published[0].event, book);
  assert.equal(entry.type, 'join');
  assert.equal(entry.member, bot.pk);
  assert.equal(entry.invitedBy.creator, owner.pk);
  assert.equal(h.saved.at(-1).announced, true);
});

test('an existing join on the relays is adopted instead of re-announced', async () => {
  const bot = keypair();
  const book = d.guestbookGroupKey(SECRET, Buffer.from(communityId, 'hex'), 0);
  const earlier = gb.sealGuestbookRumor(gb.buildJoinRumor(bot.pk), book, bot.sk);
  const h = fakeHost(bot, [earlier]);
  await new CommunityRuntime(h.host).start([record()]);
  await tick();
  assert.equal(h.published.length, 0);
  assert.equal(h.saved.at(-1).announced, true);
});

test('a community that does not match its claimed owner is refused', async () => {
  const bot = keypair();
  const h = fakeHost(bot);
  await new CommunityRuntime(h.host).start([record({ owner: keypair().pk })]);
  assert.equal(h.subs.length, 0);
  assert.ok(h.events.some(([name, e]) => name === 'error' && /claimed owner/.test(e.message)));
});

test('accepting an invite whose id does not commit to its owner is refused', () => {
  const invite = {
    protocol: 'v2', communityId, name: 'Test', accessKey: bytesToHex(SECRET), epoch: 0,
    owner: owner.pk, ownerSalt: salt, relays: [], channels: [], raw: {},
  };
  assert.equal(communityFromInvite(invite, { invitedBy: owner.pk }).communityId, communityId);
  assert.throws(() => communityFromInvite({ ...invite, owner: keypair().pk }, { invitedBy: owner.pk }), /claimed owner/);
});

test('leaving publishes a guestbook leave', async () => {
  const bot = keypair();
  const h = fakeHost(bot);
  const runtime = new CommunityRuntime(h.host);
  await runtime.announceLeave(record({ announced: true }));
  const book = d.guestbookGroupKey(SECRET, Buffer.from(communityId, 'hex'), 0);
  assert.equal(gb.openGuestbookEvent(h.published[0].event, book).type, 'leave');
});

// ── attachments (NIP-92 imeta) ───────────────────────────────────────────────

/** An imeta tag in the exact field order vector-core's attachment_to_imeta writes. */
function vectorImeta({ url, key, nonce, size, ox, name, mime = 'image/png', dim = '640x480', fallback = [] }) {
  const tag = ['imeta', `url ${url}`, `m ${mime}`, 'encryption-algorithm aes-gcm', `decryption-key ${key}`, `decryption-nonce ${nonce}`];
  if (size) tag.push(`size ${size}`);
  if (ox) tag.push(`ox ${ox}`);
  if (name) tag.push(`name ${name}`);
  tag.push('thumb abc', `dim ${dim}`);
  for (const f of fallback) tag.push(`fallback ${f}`);
  return tag;
}

test('an imeta in vector-core format parses with its crypto and metadata', () => {
  const params = generateEncryptionParams();
  const parsed = att.attachmentFromImeta(vectorImeta({ url: 'https://blossom.example/abc', ...params, size: 1234, ox: 'ab'.repeat(32), name: 'my screenshot.png' }));
  assert.equal(parsed.url, 'https://blossom.example/abc');
  assert.equal(parsed.mimeType, 'image/png');
  assert.deepEqual(parsed.encryption, params);
  assert.equal(parsed.size, 1234);
  assert.equal(parsed.hash, 'ab'.repeat(32));
  assert.equal(parsed.name, 'my screenshot.png');
  assert.equal(parsed.width, 640);
  assert.equal(parsed.height, 480);
});

test('malformed imeta tags are skipped', () => {
  assert.equal(att.attachmentFromImeta(['imeta', 'm image/png']), undefined, 'no url');
  assert.equal(att.attachmentFromImeta(['imeta', 'url https://x/y', 'decryption-key 00']), undefined, 'half the key pair');
  assert.equal(att.attachmentFromImeta(['imeta', 'url https://x/y', 'decryption-key 00', 'decryption-nonce zz']), undefined, 'non-hex nonce');
  assert.equal(att.attachmentFromImeta(['emoji', 'url https://x/y']), undefined, 'not an imeta');
  const plain = att.attachmentFromImeta(['imeta', 'url https://x/y.gif', 'm image/gif']);
  assert.equal(plain.encryption, undefined, 'foreign NIP-92 media is plain');
});

test('filenames are sanitized and fallbacks filtered', () => {
  const parsed = att.attachmentFromImeta(['imeta', 'url https://a/b', 'name ../../etc/passwd', 'fallback http://insecure/x', 'fallback https://a/b', 'fallback https://m1/x', 'fallback https://m1/x']);
  assert.ok(!parsed.name.includes('/'));
  assert.deepEqual(parsed.fallbackUrls, ['https://m1/x']);
});

test('attachments are read off a message, and inlined blob urls stripped from the caption', () => {
  const alice = keypair();
  const tag = vectorImeta({ url: 'https://blossom.example/f', ...generateEncryptionParams() });
  const rumor = chat.buildMessageRumor(alice.pk, CHANNEL, 0, 'look\nhttps://blossom.example/f', { extraTags: [tag] });
  const found = att.attachmentsFromRumor(rumor);
  assert.equal(found.length, 1);
  assert.equal(att.stripAttachmentUrls(rumor.content, found), 'look');
});

function fakeFetch(routes) {
  return async (url) => {
    const body = routes[url];
    if (!body) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
}

test('a download is decrypted and checked against its hash', async () => {
  const png = Buffer.from('\x89PNG fake image bytes');
  const params = generateEncryptionParams();
  const cipher = encryptData(png, params);
  const a = att.attachmentFromImeta(vectorImeta({ url: 'https://b/x', ...params, ox: calculateFileHash(png) }));
  const bytes = await att.downloadCommunityAttachment(a, { fetchImpl: fakeFetch({ 'https://b/x': cipher }) });
  assert.deepEqual(bytes, png);
});

test('a download that does not match its hash is refused', async () => {
  const params = generateEncryptionParams();
  const a = att.attachmentFromImeta(vectorImeta({ url: 'https://b/x', ...params, ox: '00'.repeat(32) }));
  await assert.rejects(att.downloadCommunityAttachment(a, { fetchImpl: fakeFetch({ 'https://b/x': encryptData(Buffer.from('x'), params) }) }), /hash/);
});

test('a download falls back to a mirror, and respects the size cap', async () => {
  const gif = Buffer.from('GIF89a fake');
  const params = generateEncryptionParams();
  const a = att.attachmentFromImeta(vectorImeta({ url: 'https://dead/x', ...params, fallback: ['https://mirror/x'] }));
  const bytes = await att.downloadCommunityAttachment(a, { fetchImpl: fakeFetch({ 'https://mirror/x': encryptData(gif, params) }) });
  assert.deepEqual(bytes, gif);
  const big = att.attachmentFromImeta(vectorImeta({ url: 'https://b/x', ...params, size: 999 }));
  await assert.rejects(att.downloadCommunityAttachment(big, { maxBytes: 10, fetchImpl: fakeFetch({}) }), /limit/);
});

test('attachment filenames fall back to the mime type', () => {
  assert.equal(att.attachmentFilename({ mimeType: 'image/jpeg' }), 'attachment-1.jpg');
  assert.equal(att.attachmentFilename({ mimeType: 'image/gif' }, 2), 'attachment-3.gif');
  assert.equal(att.attachmentFilename({ mimeType: 'image/png', name: 'shot.png' }), 'shot.png');
});

test('a community_message carries its attachments', async () => {
  const bot = keypair();
  const alice = keypair();
  const h = fakeHost(bot);
  await new CommunityRuntime(h.host).start([record({ announced: true })]);
  const tag = vectorImeta({ url: 'https://blossom.example/f', ...generateEncryptionParams() });
  const rumor = chat.buildMessageRumor(alice.pk, CHANNEL, 0, '', { extraTags: [tag] });
  h.deliver(chat.sealChatRumor(rumor, group, alice.sk));
  const [, message] = h.events.find(([name]) => name === 'community_message');
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].mimeType, 'image/png');
  assert.equal(typeof message.download, 'function');
});

console.log('\nconcord v2');
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
console.log(`\n${passed}/${tests.length} passed${process.exitCode ? ', FAILURES above' : ''}\n`);
