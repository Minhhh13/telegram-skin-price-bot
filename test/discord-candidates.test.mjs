import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateComponents, candidateItems, candidateSelectId, selectedCandidate } from '../discord-candidates.mjs';

const reply = `**BUFF163 base prices · CNY → VND**

**Sunburst minwear**: possible catalogue matches (price not quoted):
• ★ Specialist Gloves | Sunburst (Factory New)
• ★ Specialist Gloves | Sunburst (Minimal Wear)
Send the intended item to get its price.

**M4 redline** could mean:
• M4A1-S
• AK-47 | Redline (Field-Tested)
Send the exact name.`;

test('Discord candidate selector offers canonical items from the reply only', () => {
  assert.deepEqual(candidateItems(reply), [
    '★ Specialist Gloves | Sunburst (Factory New)',
    '★ Specialist Gloves | Sunburst (Minimal Wear)',
    'AK-47 | Redline (Field-Tested)',
  ]);
  const components = candidateComponents(reply);
  assert.equal(components[0].components[0].custom_id, candidateSelectId);
  assert.deepEqual(components[0].components[0].options.map((item) => item.value), ['0', '1', '2']);
  assert.deepEqual(candidateComponents('No matching item found.'), []);
});

test('Discord candidate selector limits choices to five', () => {
  const content = `**query**: possible catalogue matches (price not quoted):\n${[
    'AK-47 | Redline (Factory New)', 'AK-47 | Redline (Minimal Wear)',
    'AK-47 | Redline (Field-Tested)', 'AK-47 | Redline (Well-Worn)',
    'AK-47 | Redline (Battle-Scarred)', 'AWP | Redline (Field-Tested)',
  ].map((name) => `• ${name}`).join('\n')}\nSend the intended item to get its price.`;
  assert.equal(candidateItems(content).length, 5);
  assert.equal(candidateComponents(content)[0].components[0].options.length, 5);
});

test('Discord candidate selection validates the original bot message and index', () => {
  const interaction = { data: { custom_id: candidateSelectId, values: ['1'] }, message: { content: reply } };
  assert.equal(selectedCandidate(interaction), '★ Specialist Gloves | Sunburst (Minimal Wear)');
  assert.equal(selectedCandidate({ ...interaction, data: { ...interaction.data, values: ['4'] } }), null);
  assert.equal(selectedCandidate({ ...interaction, data: { ...interaction.data, values: ['../../0'] } }), null);
  assert.equal(selectedCandidate({ ...interaction, data: { ...interaction.data, custom_id: 'other' } }), null);
  assert.equal(selectedCandidate({ ...interaction, message: { content: 'unrelated' } }), null);
});
