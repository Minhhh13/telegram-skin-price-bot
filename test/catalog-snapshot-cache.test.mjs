import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveItem, catalogSuggestionsForText } from '../supabase/functions/skin-price-webhook/skin-price.mjs';
import { fuzzyCatalogMatches } from '../supabase/functions/skin-price-webhook/catalog-search.mjs';
import { collectibleSuggestions } from '../supabase/functions/skin-price-webhook/catalog-collectibles.mjs';

function snapshot(values) {
  let reads=0;
  return {names:Object.freeze(values.map(value=>Object.freeze({get name(){reads++;return value;}}))),reads:()=>reads};
}

test('an immutable catalogue snapshot is prepared once across repeated searches',async()=>{
  const tracked=snapshot(['AK-47 | Redline (Field-Tested)','AWP | Redline (Field-Tested)','Sticker | Crown (Foil)']);
  assert.deepEqual(await resolveItem('ak redline ft',undefined,tracked.names),{name:'AK-47 | Redline (Field-Tested)'});
  const resolvedReads=tracked.reads();
  assert.deepEqual(await resolveItem('ak redline ft',undefined,tracked.names),{name:'AK-47 | Redline (Field-Tested)'});
  assert.equal(tracked.reads(),resolvedReads);
  assert.deepEqual(fuzzyCatalogMatches('redlien ft',tracked.names),['AK-47 | Redline (Field-Tested)','AWP | Redline (Field-Tested)']);
  const fuzzyReads=tracked.reads();fuzzyCatalogMatches('redlien ft',tracked.names);assert.equal(tracked.reads(),fuzzyReads);
  assert.deepEqual(collectibleSuggestions('sticker crown foil',tracked.names),['Sticker | Crown (Foil)']);
  const collectibleReads=tracked.reads();collectibleSuggestions('sticker crown foil',tracked.names);assert.equal(tracked.reads(),collectibleReads);
  catalogSuggestionsForText('redlien ft',5,tracked.names);
  const allReads=tracked.reads();catalogSuggestionsForText('redlien ft',5,tracked.names);assert.equal(tracked.reads(),allReads);
});

test('replaced immutable snapshots do not inherit old names or fuzzy indexes',async()=>{
  const old=Object.freeze(['AK-47 | Redline (Field-Tested)','Sticker | Crown (Foil)']);
  const current=Object.freeze(['AWP | Redline (Field-Tested)','Sticker | Dragon (Foil)']);
  assert.deepEqual(await resolveItem('AK-47 | Redline (Field-Tested)',undefined,old),{name:old[0]});
  assert.deepEqual(await resolveItem('redline ft',undefined,current),{name:current[0]});
  assert.deepEqual(fuzzyCatalogMatches('redlien ft',old),[old[0]]);
  assert.deepEqual(fuzzyCatalogMatches('redlien ft',current),[current[0]]);
  assert.deepEqual(collectibleSuggestions('sticker dragon foil',current),[current[1]]);
  assert.deepEqual(collectibleSuggestions('sticker dragon foil',old),[]);
});

test('mutable custom catalogues still reflect in-place updates of the same length',async()=>{
  const names=['AK-47 | Redline (Field-Tested)','Sticker | Crown (Foil)'];
  assert.deepEqual(await resolveItem('redline ft',undefined,names),{name:names[0]});
  fuzzyCatalogMatches('redlien ft',names);collectibleSuggestions('sticker crown foil',names);
  names[0]='AWP | Redline (Field-Tested)';names[1]='Sticker | Dragon (Foil)';
  assert.deepEqual(await resolveItem('redline ft',undefined,names),{name:names[0]});
  assert.deepEqual(fuzzyCatalogMatches('redlien ft',names),[names[0]]);
  assert.deepEqual(collectibleSuggestions('sticker dragon foil',names),[names[1]]);
});
