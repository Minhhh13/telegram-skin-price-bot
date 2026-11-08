import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyCatalogMatches, fuzzyUniqueMatch } from '../supabase/functions/skin-price-webhook/catalog-search.mjs';

test('close spellings resolve across knives, finishes and wear', () => {
  assert.deepEqual(fuzzyUniqueMatch('Talon knife vanila'), { name: '★ Talon Knife' });
  assert.deepEqual(fuzzyUniqueMatch('glock twilght galxy fn'),
    { name: 'Glock-18 | Twilight Galaxy (Factory New)' });
  assert.deepEqual(fuzzyUniqueMatch('ak wild ltous fn'),
    { name: 'AK-47 | Wild Lotus (Factory New)' });
  assert.deepEqual(fuzzyUniqueMatch('awp dragonlroe ft'),
    { name: 'AWP | Dragon Lore (Field-Tested)' });
  assert.deepEqual(fuzzyUniqueMatch('Ak B the monster field'),
    { name: 'AK-47 | B the Monster (Field-Tested)' });
  assert.deepEqual(fuzzyUniqueMatch('Ak B the monster fild'),
    { name: 'AK-47 | B the Monster (Field-Tested)' });
  assert.deepEqual(fuzzyUniqueMatch('sunburst minwear'),
    { name: '★ Specialist Gloves | Sunburst (Minimal Wear)' });
});

test('agents use character names without requiring their unit', () => {
  assert.deepEqual(fuzzyUniqueMatch('sir bloody loudmouth'),
    { name: 'Sir Bloody Loudmouth Darryl | The Professionals' });
  assert.deepEqual(fuzzyCatalogMatches('sir bloody').length, 5);
  assert.ok(fuzzyCatalogMatches('sir bloody').every((name) => name.endsWith('| The Professionals')));
  assert.equal(fuzzyUniqueMatch('sir bloody'), null);
  assert.deepEqual(fuzzyCatalogMatches('negev loudmouth'), ['Negev | Loudmouth (Minimal Wear)']);
});

test('explicit wear and weapon constraints are never changed to fill five suggestions', () => {
  assert.deepEqual(fuzzyCatalogMatches('sunburst minwear'),
    ['★ Specialist Gloves | Sunburst (Minimal Wear)']);
  assert.deepEqual(fuzzyCatalogMatches('redline ft'), [
    'AK-47 | Redline (Field-Tested)', 'AWP | Redline (Field-Tested)',
  ]);
  assert.deepEqual(fuzzyCatalogMatches('ak nonsense ft'), []);
  assert.deepEqual(fuzzyCatalogMatches('AWP price'), []);
  assert.deepEqual(fuzzyCatalogMatches('stt a1 printstreem mw'),
    ['StatTrak™ M4A1-S | Printstream (Minimal Wear)']);
  assert.deepEqual(fuzzyUniqueMatch('AK emerald pinstripe fn'),
    { name: 'AK-47 | Emerald Pinstripe (Factory New)' });
  assert.deepEqual(fuzzyUniqueMatch('MP9 Ruby Poison Dart FT'),
    { name: 'MP9 | Ruby Poison Dart (Field-Tested)' });
});

test('Doppler shorthand preserves family and does not guess when family is absent', () => {
  assert.deepEqual(fuzzyCatalogMatches('Karam dop p4'),
    ['★ Karambit | Doppler (Factory New)']);
  assert.deepEqual(fuzzyCatalogMatches('butterfly phase3'), [
    '★ Butterfly Knife | Doppler (Factory New)',
    '★ Butterfly Knife | Gamma Doppler (Factory New)',
  ]);
  assert.equal(fuzzyUniqueMatch('butterfly phase3'), null);
  assert.deepEqual(fuzzyCatalogMatches('m9 ruby'),
    ['★ M9 Bayonet | Doppler (Factory New)']);
  assert.deepEqual(fuzzyCatalogMatches('btf gmma dop p2'),
    ['★ Butterfly Knife | Gamma Doppler (Factory New)']);
});
