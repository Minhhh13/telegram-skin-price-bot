import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const endpoint = 'https://api.openskin.dev/v1/items';
const limit = 500;
const output = resolve('supabase/functions/skin-price-webhook/catalog.mjs');

async function page(number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${endpoint}?page=${number}&limit=${limit}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((done) => setTimeout(done, (attempt + 1) * 1000));
    }
  }
}

const first = await page(1);
if (!Number.isSafeInteger(first.total) || first.total < 1000 || !Array.isArray(first.data)) throw new Error('Unexpected OpenSkin catalog response');
const pages = Math.ceil(first.total / limit);
const results = Array(pages);
results[0] = first.data;
let next = 2;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next <= pages) {
    const current = next++;
    results[current - 1] = (await page(current)).data;
  }
}));
const names = [...new Set(results.flat().map((entry) => entry?.name).filter((name) => typeof name === 'string' && name.trim()))].sort();
if (names.length < 1000) throw new Error('Catalog snapshot is unexpectedly small');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `// OpenSkin public v1 item catalog snapshot. Refresh with npm run sync:catalog.\n// Source: https://api.openskin.dev/v1/items (${new Date().toISOString()})\nexport const itemNames = ${JSON.stringify(names)};\n`);
console.log(`Saved ${names.length} catalog names from ${pages} pages`);
