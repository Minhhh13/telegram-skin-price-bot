import { itemNames } from './supabase/functions/skin-price-webhook/catalog.mjs';

const catalog = new Set(itemNames);
export const candidateSelectId = 'buff:candidate';

// Candidate lists are displayed in the bot's own reply. Discord carries that
// reply with the select interaction, so a click needs no stored search state.
export function candidateItems(content) {
  const items = [];
  const seen = new Set();
  for (const block of String(content || '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    if (!/^\*\*.+\*\*(?:: possible catalogue matches \(price not quoted\):| could mean:)$/.test(lines[0] || '')) continue;
    for (const line of lines.slice(1)) {
      const name = line.match(/^• (.+)$/)?.[1]?.trim();
      if (!name) break;
      if (!catalog.has(name) || seen.has(name)) continue;
      seen.add(name);
      items.push(name);
      if (items.length === 5) return items;
    }
  }
  return items;
}

export function candidateComponents(content) {
  const items = candidateItems(content);
  if (!items.length) return [];
  return [{ type: 1, components: [{
    type: 3, custom_id: candidateSelectId, placeholder: 'Choose an item to price',
    min_values: 1, max_values: 1,
    options: items.map((name, index) => ({ label: name.slice(0, 100), value: String(index) })),
  }] }];
}

export function selectedCandidate(interaction) {
  if (interaction?.data?.custom_id !== candidateSelectId) return null;
  const value = interaction.data.values?.[0];
  if (!/^[0-4]$/.test(String(value ?? ''))) return null;
  return candidateItems(interaction.message?.content)[Number(value)] || null;
}
