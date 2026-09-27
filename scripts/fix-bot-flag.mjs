#!/usr/bin/env node
/**
 * Clear (or set) the "bot" badge on a Nostr account.
 *
 * Why this is needed at all: Vector only re-evaluates the badge when a profile
 * actually CONTAINS a `bot` field. A profile that simply leaves it out changes
 * nothing — the flag it already holds stays. So an account wrongly marked as a
 * bot cannot be fixed by removing the field; the only thing that clears it is
 * publishing `"bot": false` explicitly.
 *
 * Kind 0 is replaceable, meaning a publish REPLACES the whole profile. This
 * reads what is currently published and writes it back with just the one field
 * changed, so nothing else is lost.
 *
 * Usage:
 *   node fix-bot-flag.mjs --nsec nsec1...            # dry run, shows the change
 *   node fix-bot-flag.mjs --nsec nsec1... --yes      # actually publish
 *   node fix-bot-flag.mjs --nsec nsec1... --set --yes  # mark AS a bot instead
 *
 * The key can also come from $VECTOR_NSEC or $NOSTR_PRIVATE_KEY, which keeps it
 * out of your shell history.
 */

import WebSocket from 'ws';
import { SimplePool, nip19 } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WebSocket;

const RELAYS = [
  'wss://jskitty.cat/nostr',
  'wss://relay.damus.io',
  'wss://purplepag.es',
  'wss://relay.nostr.band',
  'wss://nos.lol',
];

// ── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const secret = value('nsec') ?? process.env.VECTOR_NSEC ?? process.env.NOSTR_PRIVATE_KEY;
const shouldPublish = flag('yes');
const targetBotValue = flag('set'); // default false = clear the badge

if (!secret) {
  console.error('Need the account key.\n');
  console.error('  node fix-bot-flag.mjs --nsec nsec1...');
  console.error('  VECTOR_NSEC=nsec1... node fix-bot-flag.mjs');
  process.exit(1);
}

const relays = (value('relays') ?? '').split(',').map((r) => r.trim()).filter(Boolean);
const useRelays = relays.length ? [...new Set([...relays, ...RELAYS])] : RELAYS;

// ── key ──────────────────────────────────────────────────────────────────────

let sk;
try {
  const trimmed = secret.trim();
  sk = trimmed.startsWith('nsec1') ? nip19.decode(trimmed).data : hexToBytes(trimmed);
} catch (error) {
  console.error(`That is not a valid nsec or hex key: ${error.message}`);
  process.exit(1);
}
const pubkey = getPublicKey(sk);

console.log(`account : ${nip19.npubEncode(pubkey)}`);
console.log(`relays  : ${useRelays.length}`);
console.log('');

// ── read the current profile ─────────────────────────────────────────────────

const pool = new SimplePool();
await Promise.allSettled(useRelays.map((r) => pool.ensureRelay(r)));

// Take the NEWEST across all relays: a stale copy on one relay would otherwise
// overwrite a newer profile when written back.
const events = await pool.querySync(
  useRelays,
  { kinds: [0], authors: [pubkey], limit: 20 },
  { maxWait: 8000 },
);
events.sort((a, b) => b.created_at - a.created_at);
const current = events[0] ?? null;

let profile = {};
if (current) {
  try {
    profile = JSON.parse(current.content);
  } catch {
    console.error('The published profile is not valid JSON. Refusing to guess at it.');
    pool.close(useRelays);
    process.exit(1);
  }
  console.log(`current profile : published ${new Date(current.created_at * 1000).toISOString()}`);
  console.log(`  fields        : ${Object.keys(profile).join(', ') || '(none)'}`);
  console.log(`  bot flag      : ${profile.bot === undefined ? 'absent' : JSON.stringify(profile.bot)}`);
} else {
  console.log('No profile found on these relays. One will be created with just the bot field.');
  console.log('If you DO have a profile, add its relay with --relays wss://...');
  console.log('Publishing now would replace it with an almost-empty one, so stopping.');
  pool.close(useRelays);
  process.exit(1);
}

// Every other field is carried over untouched; only `bot` changes.
const updated = { ...profile, bot: targetBotValue };

console.log('');
console.log(`after   : bot = ${targetBotValue}`);
console.log(`  fields: ${Object.keys(updated).join(', ')}`);

const unchangedFields = Object.keys(profile).filter((k) => k !== 'bot');
console.log(`  keeping ${unchangedFields.length} existing field(s) exactly as they are`);

if (profile.bot === targetBotValue) {
  console.log('');
  console.log(`The published profile already says bot=${targetBotValue}.`);
  console.log('Republishing anyway is still useful: it re-asserts the field to any');
  console.log('client whose cached copy disagrees, which is the usual cause of a');
  console.log('badge that will not go away.');
}

if (!shouldPublish) {
  console.log('');
  console.log('Dry run — nothing published. Add --yes to publish.');
  pool.close(useRelays);
  process.exit(0);
}

// ── publish ──────────────────────────────────────────────────────────────────

const event = finalizeEvent(
  {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(updated),
  },
  sk,
);

const results = await Promise.allSettled(pool.publish(useRelays, event));
const ok = results.filter((r) => r.status === 'fulfilled').length;

console.log('');
console.log(`published to ${ok}/${useRelays.length} relay(s)  id=${event.id.slice(0, 16)}…`);

if (ok === 0) {
  console.error('No relay accepted it. Check connectivity and try again.');
  pool.close(useRelays);
  process.exit(1);
}

console.log('');
console.log('Done. In Vector the badge may need a restart, or a moment, to refresh');
console.log('its cached copy of your profile.');

pool.close(useRelays);
process.exit(0);
