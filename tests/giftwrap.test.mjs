// Gift-wrap authentication: the seal is the only proof of who sent a rumor.
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';

import {
  unwrapGiftWrap,
  wrapEventWithRumor,
  rewrapRumor,
  GiftWrapError,
} from '../dist/giftwrap.js';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const sk = () => {
  const s = generateSecretKey();
  return { sk: s, pk: getPublicKey(s) };
};

/** Hand-build a wrap so a rumor can claim a pubkey it did not sign for. */
function forgeWrap({ claimPubkey, signerSk, recipientPk, content = 'hi' }) {
  const rumor = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPk]],
    content,
    pubkey: claimPubkey,
  };
  rumor.id = getEventHash(rumor);

  const sealKey = nip44.v2.utils.getConversationKey(signerSk, recipientPk);
  const seal = finalizeEvent(
    { kind: 13, content: nip44.v2.encrypt(JSON.stringify(rumor), sealKey), created_at: Math.floor(Date.now() / 1000), tags: [] },
    signerSk,
  );

  const ek = generateSecretKey();
  const wrapKey = nip44.v2.utils.getConversationKey(ek, recipientPk);
  return finalizeEvent(
    { kind: 1059, content: nip44.v2.encrypt(JSON.stringify(seal), wrapKey), created_at: Math.floor(Date.now() / 1000), tags: [['p', recipientPk]] },
    ek,
  );
}

test('a genuine wrap round-trips and names its real sender', () => {
  const sender = sk();
  const recipient = sk();

  const { wrap, rumor } = wrapEventWithRumor(
    { kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', recipient.pk]], content: 'hello' },
    sender.sk,
    recipient.pk,
  );

  const back = unwrapGiftWrap(wrap, recipient.sk);
  assert.equal(back.content, 'hello');
  assert.equal(back.pubkey, sender.pk, 'the sender is the real signer');
  assert.equal(back.id, rumor.id, 'the id survives, so replies can reference it');
});

test('a rumor claiming someone else is REJECTED', () => {
  const owner = sk();
  const attacker = sk();
  const victim = sk();

  // The attacker cannot sign as the owner, so they sign with their own key
  // while the rumor claims the owner's pubkey.
  const wrap = forgeWrap({
    claimPubkey: owner.pk,
    signerSk: attacker.sk,
    recipientPk: victim.pk,
    content: '/promote attacker',
  });

  assert.throws(
    () => unwrapGiftWrap(wrap, victim.sk),
    (e) => e instanceof GiftWrapError && /claims to be from/.test(e.message),
    'impersonation must not be accepted',
  );
});

test('a tampered seal signature is rejected', () => {
  const sender = sk();
  const recipient = sk();
  const { wrap } = wrapEventWithRumor(
    { kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'x' },
    sender.sk,
    recipient.pk,
  );

  // Re-wrap a seal whose signature has been corrupted.
  const wrapKey = nip44.v2.utils.getConversationKey(recipient.sk, wrap.pubkey);
  const seal = JSON.parse(nip44.v2.decrypt(wrap.content, wrapKey));
  seal.sig = seal.sig.replace(/^../, seal.sig.startsWith('00') ? '11' : '00');

  const ek = generateSecretKey();
  const badWrap = finalizeEvent(
    {
      kind: 1059,
      content: nip44.v2.encrypt(
        JSON.stringify(seal),
        nip44.v2.utils.getConversationKey(ek, recipient.pk),
      ),
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipient.pk]],
    },
    ek,
  );

  assert.throws(
    () => unwrapGiftWrap(badWrap, recipient.sk),
    (e) => e instanceof GiftWrapError && /signature is invalid/.test(e.message),
  );
});

test('a rumor whose id does not match its contents is rejected', () => {
  const sender = sk();
  const recipient = sk();

  const rumor = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: 'real',
    pubkey: sender.pk,
  };
  rumor.id = getEventHash(rumor);
  rumor.content = 'swapped after the id was computed';

  const sealKey = nip44.v2.utils.getConversationKey(sender.sk, recipient.pk);
  const seal = finalizeEvent(
    { kind: 13, content: nip44.v2.encrypt(JSON.stringify(rumor), sealKey), created_at: Math.floor(Date.now() / 1000), tags: [] },
    sender.sk,
  );
  const ek = generateSecretKey();
  const wrap = finalizeEvent(
    {
      kind: 1059,
      content: nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(ek, recipient.pk)),
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipient.pk]],
    },
    ek,
  );

  assert.throws(
    () => unwrapGiftWrap(wrap, recipient.sk),
    (e) => e instanceof GiftWrapError && /id does not match/.test(e.message),
  );
});

test('a non-gift-wrap is rejected', () => {
  const recipient = sk();
  assert.throws(
    () => unwrapGiftWrap({ kind: 1, content: 'x', pubkey: recipient.pk, tags: [] }, recipient.sk),
    (e) => e instanceof GiftWrapError && /Not a gift wrap/.test(e.message),
  );
});

test('a wrap addressed to someone else cannot be opened', () => {
  const sender = sk();
  const recipient = sk();
  const stranger = sk();
  const { wrap } = wrapEventWithRumor(
    { kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'private' },
    sender.sk,
    recipient.pk,
  );
  assert.throws(() => unwrapGiftWrap(wrap, stranger.sk));
});

test('the self-wrap authenticates as the same sender', () => {
  const sender = sk();
  const recipient = sk();
  const { rumor } = wrapEventWithRumor(
    { kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'multi-device' },
    sender.sk,
    recipient.pk,
  );

  const selfWrap = rewrapRumor(rumor, sender.sk, sender.pk);
  const back = unwrapGiftWrap(selfWrap, sender.sk);
  assert.equal(back.id, rumor.id);
  assert.equal(back.pubkey, sender.pk);
});

console.log('\ngift-wrap authentication');
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
