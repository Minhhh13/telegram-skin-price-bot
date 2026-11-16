import test from 'node:test';
import assert from 'node:assert/strict';
import { itemNames } from '../supabase/functions/skin-price-webhook/catalog.mjs';
import { createTradeDeskClient, identityKey, itemLabel, resolveProfitRequest } from '../profit.mjs';
import { auditCatalogue } from '../scripts/profit-catalog-audit.mjs';

function snapshot(items) {
  return { items: Object.freeze(items.map((item) => Object.freeze({ game: '730', phase: null, ...item }))),
    names: Object.freeze([...new Set(items.map((item) => item.name))]) };
}

const publicCatalogue = snapshot(itemNames.map((name) => ({ name })));
const butterfly = '★ Butterfly Knife | Doppler (Factory New)';
const gamma = '★ Butterfly Knife | Gamma Doppler (Factory New)';
const styles = ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Ruby', 'Sapphire', 'Black Pearl'];
const phasedCatalogue = snapshot([
  ...styles.map((phase) => ({ name: butterfly, phase })),
  ...['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Emerald'].map((phase) => ({ name: gamma, phase })),
]);

test('every bundled public title roundtrips through the profit parser without losing punctuation or identity', async () => {
  for (const item of publicCatalogue.items) {
    const result = await resolveProfitRequest(itemLabel(item), publicCatalogue);
    assert.deepEqual(result.items, [item], item.name);
    assert.deepEqual(result.unresolved, [], item.name);
  }
});

test('a wrapped exact title keeps its internal commas and terminal punctuation', async () => {
  for (const [prefix, name] of [
    ['check', 'Music Kit | bbno$, u mad!'],
    ['price for', 'StatTrak™ Music Kit | Daniel Sadowski, Eye of the Dragon'],
    ['please check', 'Music Kit | Scarlxrd, CHAIN$AW.LXADXUT.'],
  ]) {
    for (const query of [`${prefix} ${name}`, `${prefix} ${name} rate 3.65`]) {
      const result = await resolveProfitRequest(query, publicCatalogue);
      assert.deepEqual(result.items.map((item) => item.name), [name], query);
      assert.deepEqual(result.unresolved, [], query);
    }
  }
});

test('all Doppler identities remain individually reachable and an unlabeled phase base requires a choice', async () => {
  for (const item of phasedCatalogue.items) {
    for (const query of [itemLabel(item), `${item.name} ${item.phase} rate 3.65`]) {
      const result = await resolveProfitRequest(query, phasedCatalogue);
      assert.deepEqual(result.items, [item], query);
      assert.deepEqual(result.unresolved, [], query);
    }
  }
  const base = await resolveProfitRequest(butterfly, phasedCatalogue);
  assert.deepEqual(base.items, []);
  assert.equal(base.unresolved[0].candidates.length, styles.length);
  assert.equal(new Set(base.unresolved[0].candidates.map(identityKey)).size, styles.length);
  assert.ok(base.unresolved[0].candidates.every((item) => item.name === butterfly && item.phase));
  const withBase = snapshot([...phasedCatalogue.items, { name: butterfly }]);
  assert.deepEqual((await resolveProfitRequest(butterfly, withBase)).items,
    [withBase.items.find((item) => item.name === butterfly && !item.phase)]);
});

test('human shorthand preserves phase, wear, StatTrak, agent and collectible identity', async () => {
  for (const [query, name] of [
    ['ak redline ft', 'AK-47 | Redline (Field-Tested)'],
    ['awp dragonlroe ft', 'AWP | Dragon Lore (Field-Tested)'],
    ['stt a1 printstreem mw', 'StatTrak™ M4A1-S | Printstream (Minimal Wear)'],
    ['talon vanila', '★ Talon Knife'],
    ['bayonet', '★ Bayonet'],
    ['sir bloody loudmouth', 'Sir Bloody Loudmouth Darryl | The Professionals'],
    ['dragomir sabre', 'Dragomir | Sabre'],
    ['soldier phoenix', 'Soldier | Phoenix'],
    ['sticker crown foil', 'Sticker | Crown (Foil)'],
    ['sticker slab crown foil', 'Sticker Slab | Crown (Foil)'],
    ['00 nation gold rio 2022 sticker', 'Sticker | 00 Nation (Gold) | Rio 2022'],
  ]) {
    const result = await resolveProfitRequest(query, publicCatalogue);
    assert.deepEqual(result.items.map((item) => item.name), [name], query);
    assert.deepEqual(result.unresolved, [], query);
  }
  for (const [query, name, phase] of [
    ['btf dop p3', butterfly, 'Phase 3'], ['Butterfly Knife Doppler FN phase 3', butterfly, 'Phase 3'],
    ['btf gmma dop p2', gamma, 'Phase 2'], ['btf ruby', butterfly, 'Ruby'], ['btf emerald', gamma, 'Emerald'],
  ]) {
    const result = await resolveProfitRequest(query, phasedCatalogue);
    assert.deepEqual(result.items.map((item) => [item.name, item.phase]), [[name, phase]], query);
  }
});

test('Unicode normalization preserves canonical accents and distinct Japanese finish names', async () => {
  const name = 'AUG | Flame Jörmungandr (Factory New)';
  const normalized = await resolveProfitRequest(name.normalize('NFD'), publicCatalogue);
  assert.deepEqual(normalized.items.map((item) => item.name), [name]);
  assert.deepEqual(normalized.unresolved, []);
  for (const suffix of ['壱', '弐']) {
    const finish = `Desert Eagle | Sunset Storm ${suffix} (Factory New)`;
    assert.deepEqual((await resolveProfitRequest(finish, publicCatalogue)).items.map((item) => item.name), [finish]);
  }
});

test('a missing wear or collectible event never changes the explicit fields to fill suggestions', async () => {
  for (const query of ['ak redline fn', 'sticker 00 nation gold boston 2018', 'sticker crown holo']) {
    const result = await resolveProfitRequest(query, publicCatalogue);
    assert.deepEqual(result.items, [], query);
    assert.ok(result.unresolved.length, query);
    if (query.includes('sticker')) assert.deepEqual(result.unresolved[0].candidates, [], query);
    else assert.ok(result.unresolved[0].candidates.every((item) =>
      item.name.startsWith('AK-47 |') && item.name.endsWith('(Factory New)') && !item.name.startsWith('StatTrak')), query);
  }
  const typo = await resolveProfitRequest('redlien ft', publicCatalogue);
  assert.deepEqual(new Set(typo.unresolved[0].candidates.map((item) => item.name)), new Set([
    'AK-47 | Redline (Field-Tested)', 'AWP | Redline (Field-Tested)',
  ]));
  const broad = await resolveProfitRequest('sir bloody', publicCatalogue);
  assert.equal(broad.unresolved[0].candidates.length, 5);
  assert.ok(broad.unresolved[0].candidates.every((item) => item.name.endsWith('| The Professionals')));
});

test('a known phase without a family offers only real identities with that phase', async () => {
  const result = await resolveProfitRequest('butterfly phase3 fn rate 3.65', phasedCatalogue);
  assert.deepEqual(result.items, []);
  assert.deepEqual(new Set(result.unresolved[0].candidates.map(identityKey)), new Set([
    identityKey({ game: '730', name: butterfly, phase: 'Phase 3' }),
    identityKey({ game: '730', name: gamma, phase: 'Phase 3' }),
  ]));
  assert.deepEqual(result.rates, [3.65]);
});

test('catalogue ingestion accepts numeric games and preserves literal wire titles including outer spaces', async () => {
  const title = 'StatTrak™ Music Kit | Daniel Sadowski, Eye of the Dragon';
  const client = createTradeDeskClient({ url: 'https://tradedesk.test', apiKey: 'local-test', guildId: 'local-test' },
    async () => ({ ok: true, json: async () => ({ items: [
      { game: 730, name: `  ${title} `, phase: null },
      { game: '730', name: ` ${butterfly} `, phase: ' phase 3 ' },
      { game: '730', name: butterfly, phase: 'p2' },
      { game: '252490', name: 'Unrelated game', phase: null },
      { game: '730', name: 123, phase: null },
      { game: '730', name: butterfly, phase: 'Invented Style' },
      { game: '730', name: `\t${title}`, phase: null },
    ] }) }));
  const catalogue = await client.catalogue('local-test');
  assert.deepEqual(catalogue.items, [
    { game: '730', name: `  ${title} `, phase: null },
    { game: '730', name: ` ${butterfly} `, phase: 'Phase 3' },
    { game: '730', name: butterfly, phase: 'Phase 2' },
  ]);
  assert.deepEqual((await resolveProfitRequest(`${title} rate 3.65`, catalogue)).items, [catalogue.items[0]]);
  assert.deepEqual((await resolveProfitRequest(`${butterfly} Phase 3`, catalogue)).items, [catalogue.items[1]]);
});

test('literal NFC and NFD catalogue rows remain distinct identities and normalized spelling requires a choice', async () => {
  const title = 'AUG | Flame Jörmungandr (Factory New)';
  const rows = [title, title.normalize('NFD')].map((name) => ({ game: '730', name, phase: null }));
  const client = createTradeDeskClient({ url: 'https://tradedesk.test', apiKey: 'local-test', guildId: 'local-test' },
    async () => ({ ok: true, json: async () => ({ items: rows }) }));
  const catalogue = await client.catalogue('local-test');
  assert.deepEqual(catalogue.items, rows);
  assert.equal(catalogue.byId.size, 2);
  for (const row of rows) assert.deepEqual((await resolveProfitRequest(row.name, catalogue)).items, [row]);
  const ambiguous = await resolveProfitRequest('aug flame jörmungandr factory new', catalogue);
  assert.deepEqual(ambiguous.items, []);
  assert.deepEqual(new Set(ambiguous.unresolved[0].candidates.map(identityKey)), new Set(rows.map(identityKey)));
  const audit = await auditCatalogue(rows, { humanTitles: true });
  assert.equal(audit.passed, true);
  assert.equal(audit.uniqueSupportedIdentities, 2);
  assert.equal(audit.ingestedIdentities, 2);
  assert.equal(audit.humanTitleCollisionQueries, 2);
});

test('local catalogue audit counts rejected source rows separately from covered identities', async () => {
  const result = await auditCatalogue([
    { game: '730', name: 'AK-47 | Redline (Field-Tested)', phase: null },
    { game: '730', name: butterfly, phase: 'Phase 3' },
    { game: '252490', name: 'Unrelated game', phase: null },
    { game: '730', name: '', phase: null },
  ]);
  assert.equal(result.passed, true);
  assert.equal(result.inputRows, 4);
  assert.equal(result.supportedInputRows, 2);
  assert.equal(result.uniqueSupportedIdentities, 2);
  assert.equal(result.ingestedIdentities, 2);
  assert.equal(result.unsupportedInputRows, 2);
  assert.deepEqual(result.unsupportedCategories, { 'unsupported-game': 1, 'invalid-name': 1 });
  assert.equal(result.canonicalQueries, 2);
  assert.equal(result.rateQueries, 2);
  assert.equal(result.phaseBaseQueries, 1);
});
