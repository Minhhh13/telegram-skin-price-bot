// Local-only audit. Reads identities, never configuration, credentials or prices.
// Usage: node scripts/profit-catalog-audit.mjs [--catalogue snapshot.json] [--human-titles] [--output report.json]
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { itemNames } from '../supabase/functions/skin-price-webhook/catalog.mjs';
import { createTradeDeskClient, identityKey, itemLabel, resolveProfitRequest } from '../profit.mjs';

const knownPhases = new Map(['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Ruby', 'Sapphire', 'Emerald', 'Black Pearl']
  .map((phase) => [phase.toLowerCase().replace(/\s+/g, ''), phase]));
const publicNames = new Set(itemNames);
for (let number = 1; number <= 4; number++) knownPhases.set(`p${number}`, `Phase ${number}`);

function expectedIdentity(row) {
  if (!row || String(row.game) !== '730') return { reason: 'unsupported-game' };
  if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 512 || /[\x00-\x1f\x7f]/.test(row.name)) return { reason: 'invalid-name' };
  if (row.phase != null && typeof row.phase !== 'string') return { reason: 'unsupported-phase' };
  const phaseText = row.phase == null ? '' : row.phase.trim();
  const phase = phaseText ? knownPhases.get(phaseText.toLowerCase().replace(/[\s_-]+/g, '')) : null;
  if (phaseText && !phase) return { reason: 'unsupported-phase' };
  // Wire names are identities. Search may normalize them; this source oracle
  // must retain whitespace and Unicode form so it detects identity mutation.
  return { item: { game: '730', name: row.name, phase } };
}

const sameIdentities = (actual, expected) => actual.length === expected.length &&
  actual.every((item) => expected.some((other) => identityKey(item) === identityKey(other)));

export async function auditCatalogue(sourceItems, { source = 'supplied-snapshot', humanTitles = false } = {}) {
  if (!Array.isArray(sourceItems)) throw new Error('The snapshot must be an identity array or an object with an items array.');
  const started = performance.now(), expected = new Map(), unsupported = {};
  let supportedInputRows = 0, failureCount = 0;
  const examples = [], failureCategories = {};
  const fail = (category, detail) => {
    failureCount++;
    failureCategories[category] = (failureCategories[category] || 0) + 1;
    if (examples.length < 20) examples.push({ category, ...detail });
  };
  for (const row of sourceItems) {
    const normalized = expectedIdentity(row);
    if (normalized.reason) unsupported[normalized.reason] = (unsupported[normalized.reason] || 0) + 1;
    else { supportedInputRows++; expected.set(identityKey(normalized.item), normalized.item); }
  }
  let catalogue;
  try {
    const client = createTradeDeskClient({ url: 'https://catalogue-audit.invalid', apiKey: 'local-only', guildId: 'local-only' },
      async () => ({ ok: true, json: async () => ({ items: sourceItems, version: 'local-audit' }) }));
    catalogue = await client.catalogue('local-only');
  } catch (error) {
    fail('catalogue-ingestion', { message: error.message });
  }
  let canonicalQueries = 0, rateQueries = 0, phaseBaseQueries = 0, humanTitleQueries = 0, humanTitleCollisionQueries = 0;
  const timings = [];
  if (catalogue) {
    const accepted = new Map(catalogue.items.map((item) => [identityKey(item), item]));
    for (const item of expected.values()) if (!accepted.has(identityKey(item))) fail('source-identity-dropped', { item });
    for (const item of catalogue.items) if (!expected.has(identityKey(item))) fail('unexpected-ingested-identity', { item });
    for (const item of expected.values()) {
      for (const [variant, query] of [['canonical', itemLabel(item)], ['rate', `!profit ${itemLabel(item)} rate 3.65`]]) {
        try {
          const result = await resolveProfitRequest(query, catalogue);
          if (!sameIdentities(result.items, [item]) || result.unresolved.length)
            fail(`${variant}-roundtrip`, { item, returned: result.items, unresolved: result.unresolved.map((entry) => entry.message) });
          if (variant === 'rate' && (result.rates.length !== 1 || result.rates[0] !== 3.65)) fail('rate-preservation', { item });
        } catch (error) { fail(`${variant}-roundtrip`, { item, message: error.message }); }
        if (variant === 'canonical') canonicalQueries++; else rateQueries++;
      }
    }
    const phasedNames = new Map();
    for (const item of expected.values()) if (item.phase) {
      if (!phasedNames.has(item.name)) phasedNames.set(item.name, []);
      phasedNames.get(item.name).push(item);
    }
    for (const [name, variants] of phasedNames) {
      phaseBaseQueries++;
      const base = expected.get(identityKey({ game: '730', name, phase: null }));
      try {
        const result = await resolveProfitRequest(name, catalogue);
        if (base) {
          if (!sameIdentities(result.items, [base]) || result.unresolved.length) fail('base-phase-distinction', { name });
        } else {
          const candidates = result.unresolved.flatMap((entry) => entry.candidates);
          if (result.items.length || !candidates.length || candidates.length > 25 ||
              candidates.some((item) => !variants.some((variant) => identityKey(item) === identityKey(variant))))
            fail('ambiguous-phase-base', { name });
        }
      } catch (error) { fail('base-phase-distinction', { name, message: error.message }); }
    }
    if (humanTitles) {
      // Exercise a second spelling for every source identity. Keep Unicode
      // letters and numbers while removing title separators and ornamentation.
      const human = (item) => itemLabel(item).normalize('NFKC').toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
      const groups = new Map(), literalLabels = new Set();
      for (const item of expected.values()) {
        const query = human(item);
        if (!groups.has(query)) groups.set(query, []);
        groups.get(query).push(item);
        literalLabels.add(itemLabel(item).toLowerCase());
      }
      for (const item of expected.values()) {
        const query = human(item), equivalent = groups.get(query);
        humanTitleQueries++;
        if (equivalent.length > 1) humanTitleCollisionQueries++;
        try {
          const result = await resolveProfitRequest(query, catalogue);
          if (equivalent.length === 1) {
            if (!sameIdentities(result.items, [item]) || result.unresolved.length) fail('human-title-roundtrip', { item, query });
          } else if (literalLabels.has(query)) {
            // A complete literal catalogue title retains precedence over its
            // punctuation-free cousins. It must remain in the same group.
            if (result.items.some((row) => !equivalent.some((other) => identityKey(row) === identityKey(other))))
              fail('human-title-collision-identity', { item, query });
          } else {
            const candidates = result.unresolved.flatMap((entry) => entry.candidates);
            if (result.items.length || !candidates.length || candidates.length > 25 ||
                candidates.some((row) => !equivalent.some((other) => identityKey(row) === identityKey(other))) ||
                (equivalent.length <= 25 && !sameIdentities(candidates, equivalent)))
              fail('human-title-collision-choice', { item, query });
          }
        } catch (error) { fail('human-title-roundtrip', { item, query, message: error.message }); }
      }
    }
    const queries = ['ak redline ft', 'awp dragonlroe ft', 'stt a1 printstreem mw', 'sir bloody loudmouth',
      'sir bloody', 'sticker crown foil', 'sticker 00 nation gold rio 2022', 'btf gamma dop p3',
      'glock twilght galxy fn', 'sunburst minwear', 'redlien ft', 'sticker 00 nation gold boston 2018'];
    for (let cycle = 0; cycle < 5; cycle++) for (const query of queries) {
      const at = performance.now();
      try { await resolveProfitRequest(query, catalogue); } catch { /* Counts are tested independently of timings. */ }
      if (cycle) timings.push(performance.now() - at);
    }
  }
  timings.sort((a, b) => a - b);
  const rounded = (value) => Number(value.toFixed(2));
  return {
    passed: failureCount === 0, source, inputRows: sourceItems.length, supportedInputRows,
    unsupportedInputRows: sourceItems.length - supportedInputRows, unsupportedCategories: unsupported,
    uniqueSupportedIdentities: expected.size, ingestedIdentities: catalogue?.items.length || 0,
    duplicateSupportedRows: supportedInputRows - expected.size,
    uniqueNames: new Set([...expected.values()].map((item) => item.name)).size,
    phaseIdentities: [...expected.values()].filter((item) => item.phase).length,
    namesAbsentFromPublicSnapshot: [...new Set([...expected.values()].map((item) => item.name))]
      .filter((name) => !publicNames.has(name)).length,
    canonicalQueries, rateQueries, phaseBaseQueries, humanTitleQueries, humanTitleCollisionQueries,
    failureCount, failureCategories, examples,
    elapsedMs: rounded(performance.now() - started), warmQueries: timings.length,
    warmMedianMs: timings.length ? rounded(timings[Math.floor(timings.length / 2)]) : null,
    warmP95Ms: timings.length ? rounded(timings[Math.floor(timings.length * .95)]) : null,
    rssMb: rounded(process.memoryUsage().rss / 1048576),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Local only: node scripts/profit-catalog-audit.mjs [--catalogue snapshot.json] [--human-titles] [--output report.json]\nWithout --catalogue, audits the public name snapshot as phase-null identities; it does not claim live Trade Desk coverage.');
    return;
  }
  const option = (key) => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
  const path = option('--catalogue');
  const sourceText = path ? await readFile(resolve(path), 'utf8') : null;
  const input = sourceText ? JSON.parse(sourceText) : itemNames.map((name) => ({ game: '730', name, phase: null }));
  const rows = Array.isArray(input) ? input : Array.isArray(input.catalogues)
    ? input.catalogues.flatMap((catalogue) => catalogue.rows.map((row) => ({ game: catalogue.game, name: row[1], phase: row[2] })))
    : input.items;
  const result = await auditCatalogue(rows, { source: path ? 'supplied-snapshot' : 'public-name-snapshot-phase-null', humanTitles: args.includes('--human-titles') });
  if (path) { result.sourceFile = basename(path); result.sourceSha256 = createHash('sha256').update(sourceText).digest('hex'); }
  if (typeof input.capturedAt === 'string') result.sourceCapturedAt = input.capturedAt;
  if (typeof input.version === 'string') result.catalogueVersion = input.version;
  const report = `${JSON.stringify(result, null, 2)}\n`;
  if (option('--output')) await writeFile(resolve(option('--output')), report);
  console.log(report.trimEnd());
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
