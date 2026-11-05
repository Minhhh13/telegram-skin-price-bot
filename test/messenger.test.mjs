import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { answerMessengerMessage, messengerText, parseMessengerRequest, startMessengerListener } from '../messenger.mjs';

const threadId = '4128828130587827';
const accountId = '123456';

test('only !buff and actual account mentions in the intended group trigger a lookup', () => {
  const base = { threadId, senderId: 'other', messageId: 'message-1', attachments: [] };
  assert.deepEqual(parseMessengerRequest({ ...base, text: '!buff awp long dog ft' }, accountId, threadId),
    { text: 'awp long dog ft', hasImage: false });
  assert.deepEqual(parseMessengerRequest({ ...base, text: '@BUFF BOT PRICE CHECKER awp redline', mentions: [{ id: accountId }] }, accountId, threadId),
    { text: 'awp redline', hasImage: false });
  assert.deepEqual(parseMessengerRequest({ ...base, text: '@Thang Manh Nguyen ak slate' }, accountId, threadId),
    { text: 'ak slate', hasImage: false });
  assert.equal(parseMessengerRequest({ ...base, threadId: 'competitor-group', text: '@Thang Manh Nguyen ak slate' }, accountId, threadId), null);
  assert.equal(parseMessengerRequest({ ...base, text: 'awp long dog ft' }, accountId, threadId), null);
  assert.equal(parseMessengerRequest({ ...base, threadId: 'competitor-group', text: '!buff awp long dog ft' }, accountId, threadId), null);
  assert.equal(parseMessengerRequest({ ...base, senderId: accountId, text: '!buff awp long dog ft' }, accountId, threadId), null);
});

test('photo request requires trigger and preserves image state', () => {
  const event = { threadId, senderId: 'other', text: '!buff', attachments: [{ attachmentType: 1 }] };
  assert.deepEqual(parseMessengerRequest(event, accountId, threadId), { text: '', hasImage: true });
});

test('messages outside the intended group cause no send', async () => {
  const sent = [];
  const client = { getUserId: () => accountId, sendMessage: (...args) => sent.push(args) };
  const handled = await answerMessengerMessage(client, { threadId: 'competitor-group', senderId: 'other', text: '!buff awp long dog ft' }, { threadId });
  assert.equal(handled, false);
  assert.equal(sent.length, 0);
});

test('Messenger formatting uses plain text and a direct source link', () => {
  assert.equal(messengerText('**AWP** · [BUFF listing](https://buff.163.com/goods/123)\n`3.75 → ₫10,000`'),
    'AWP · BUFF listing: https://buff.163.com/goods/123\n3.75 → ₫10,000');
});

test('inbox refresh answers one new group request and ignores old or duplicate messages', async () => {
  const sent = [];
  let connections = 0;
  class FakeClient extends EventEmitter {
    connected = false;
    get isConnected() { return this.connected; }
    async connect() {
      this.connected = true;
      connections++;
      const timestampMs = BigInt(Date.now());
      return { user: { id: BigInt(accountId) }, initialData: { threads: [{ id: BigInt(threadId), type: 2 }], messages: [
        { id: 'old', threadId: BigInt(threadId), senderId: 999n, text: '!buff', timestampMs: timestampMs - 300_000n },
        ...(connections > 1 ? [{ id: 'fresh', threadId: BigInt(threadId), senderId: 999n, text: '!buff', timestampMs }] : []),
      ] } };
    }
    getCookies() { return { c_user: accountId, xs: 'test' }; }
    async disconnect() { this.connected = false; }
    async sendMessage(id, payload) { sent.push({ id, payload }); }
  }
  const listener = startMessengerListener({ cookies: `c_user=${accountId}; xs=test`, threadId }, FakeClient,
    { retryMs: 10, snapshotRefreshMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(connections >= 2);
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.text, /Send !buff followed by skin names/);
  } finally { listener.stop(); }
});
