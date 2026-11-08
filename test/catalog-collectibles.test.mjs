import test from 'node:test';
import assert from 'node:assert/strict';
import { collectibleSuggestions, resolveCollectible } from '../supabase/functions/skin-price-webhook/catalog-collectibles.mjs';

test('sticker modifiers, event, and year are part of the item identity', () => {
  assert.deepEqual(resolveCollectible('Sticker | 00 Nation (Glitter) | Rio 2022'),
    { name: 'Sticker | 00 Nation (Glitter) | Rio 2022' });
  assert.deepEqual(resolveCollectible('00 Nation Glitter Rio 2022 sticker'),
    { name: 'Sticker | 00 Nation (Glitter) | Rio 2022' });
  assert.deepEqual(resolveCollectible('sticker 00 nation gold rio 2022'),
    { name: 'Sticker | 00 Nation (Gold) | Rio 2022' });
  assert.deepEqual(resolveCollectible('sticker 00 nation rio 2022'),
    { name: 'Sticker | 00 Nation | Rio 2022' });
  assert.equal(resolveCollectible('sticker 00 nation gold boston 2018'), null);
});

test('sticker slab and foil are kept distinct from the ordinary sticker', () => {
  assert.deepEqual(resolveCollectible('Sticker | Crown (Foil)'),
    { name: 'Sticker | Crown (Foil)' });
  assert.deepEqual(resolveCollectible('sticker slab crown foil'),
    { name: 'Sticker Slab | Crown (Foil)' });
  assert.deepEqual(collectibleSuggestions('crown foil'),
    ['Sticker | Crown (Foil)', 'Sticker Slab | Crown (Foil)']);
  assert.equal(resolveCollectible('crown foil')?.ambiguous?.length, 2);
  assert.deepEqual(resolveCollectible('sticker crown'),
    { name: 'Sticker | Crown (Foil)' });
  assert.equal(resolveCollectible('sticker crown gold'), null);
});

test('a leading article can distinguish otherwise identical souvenir charms', () => {
  assert.deepEqual(resolveCollectible('souvenir charm austin 2025 highlight the defender'),
    { name: 'Souvenir Charm | Austin 2025 Highlight | The Defender' });
  assert.deepEqual(resolveCollectible('souvenir charm austin 2025 highlight a defender'),
    { name: 'Souvenir Charm | Austin 2025 Highlight | A Defender' });
  const omitted = resolveCollectible('souvenir charm austin 2025 highlight defender');
  assert.deepEqual(omitted?.ambiguous, [
    'Souvenir Charm | Austin 2025 Highlight | A Defender',
    'Souvenir Charm | Austin 2025 Highlight | Defender',
    'Souvenir Charm | Austin 2025 Highlight | The Defender',
  ]);
});

test('close spellings correct a unique collectible without changing the variant', () => {
  assert.deepEqual(resolveCollectible('sticker 00 nation gliter rio 2022'),
    { name: 'Sticker | 00 Nation (Glitter) | Rio 2022' });
  assert.deepEqual(resolveCollectible('sticker crown ffoil'),
    { name: 'Sticker | Crown (Foil)' });
  assert.equal(resolveCollectible('sticker crown holo'), null);
});

test('ambiguous collectible names return real candidates and indicate more matches', () => {
  const variants = resolveCollectible('sticker 00 nation');
  assert.ok(variants?.ambiguous?.length >= 3);
  assert.ok(variants.ambiguous.every((name) => name.startsWith('Sticker | 00 Nation')));
  const broad = resolveCollectible('sticker rio 2022');
  assert.equal(broad?.ambiguous?.length, 5);
  assert.equal(broad.more, true);
});

test('other collectible classes resolve without taking over skin requests', () => {
  assert.deepEqual(resolveCollectible('Souvenir Charm | Austin 2025 Highlight | 1 Bullet'),
    { name: 'Souvenir Charm | Austin 2025 Highlight | 1 Bullet' });
  assert.deepEqual(resolveCollectible('Sealed Graffiti | 1G (Blood Red)'),
    { name: 'Sealed Graffiti | 1G (Blood Red)' });
  assert.deepEqual(resolveCollectible('Autograph Capsule | Astralis | Atlanta 2017'),
    { name: 'Autograph Capsule | Astralis | Atlanta 2017' });
  assert.deepEqual(resolveCollectible('kilowatt case'), { name: 'Kilowatt Case' });
  assert.deepEqual(resolveCollectible('10 Year Birthday Sticker Capsule'),
    { name: '10 Year Birthday Sticker Capsule' });
  assert.deepEqual(resolveCollectible('10 year birthday sticker capsule'),
    { name: '10 Year Birthday Sticker Capsule' });
  assert.equal(resolveCollectible('ak redline ft'), null);
});
