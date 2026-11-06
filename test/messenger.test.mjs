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
  assert.deepEqual(parseMessengerRequest({ ...base, text: '@BUFF BOT PRICE CHECKER ak bthemonster mw' }, accountId, threadId),
    { text: 'ak bthemonster mw', hasImage: false });
  assert.deepEqual(parseMessengerRequest({ ...base, text: '@Thang Manh Nguyen ak slate' }, accountId, threadId),
    { text: 'ak slate', hasImage: false });
  assert.deepEqual(parseMessengerRequest({ ...base, text: '@Thang Manh Nguyen stt printstream ft' }, accountId, threadId),
    { text: 'stt printstream ft', hasImage: false });
  assert.deepEqual(parseMessengerRequest({ ...base, text: '@Thang Manh Nguyen redline awp ft' }, accountId, threadId),
    { text: 'redline awp ft', hasImage: false });
  assert.deepEqual(parseMessengerRequest({ ...base, text: 'please price redline awp ft @Thang Manh Nguyen' }, accountId, threadId),
    { text: 'please price redline awp ft', hasImage: false });
  assert.equal(parseMessengerRequest({ ...base, text: '@Thang Manh Nguyen mẹ gia minh' }, accountId, threadId), null);
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

test('Messenger send failure propagates without a second generic reply', async () => {
  const sent = [];
  const client = {
    getUserId: () => accountId,
    sendMessage: async (_thread, content) => {
      sent.push(content);
      throw new Error('temporary send failure');
    },
  };
  await assert.rejects(
    answerMessengerMessage(client,
      { threadId, senderId: 'other', messageId: 'retry-message', text: '!buff ak redline ft' },
      { threadId, lookup: async () => ['**AK-47 | Redline (Field-Tested)**'] }),
    /temporary send failure/,
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0], /AK-47 \| Redline/);
});

test('Messenger formatting is readable on a phone with a direct BUFF link', () => {
  const reply = messengerText('**BUFF163 base prices · CNY → VND**\n\n**AWP | Redline (Field-Tested)**\n**¥200.48 CNY** · BUFF163 feed ask · [BUFF listing](https://buff.163.com/goods/123)\n`3.75 → ₫751,800   |   3.78 → ₫757,814`\nFeed snapshot 2026-11-05 16:25 UTC (57 min old) ⚠️ May miss newer listings');
  assert.match(reply, /^🎯 BUFF163 PRICE CHECK\n\n◆ AWP \| Redline \(Field-Tested\)/);
  assert.match(reply, /💴 ¥200\.48 CNY\n🔗 https:\/\/buff\.163\.com\/goods\/123/);
  assert.doesNotMatch(reply, /feed ask/);
  assert.match(reply, /3\.75 → ₫751,800\n   3\.78 → ₫757,814/);
  assert.match(reply, /🕒 Feed 57 min old · 16:25 UTC/);
  assert.match(reply, /⚠️ May miss newer listings/);
  assert.doesNotMatch(reply, /Item #|CNY → VND|\[BUFF listing\]/);
});

test('inbox refresh answers a request from the second snapshot once despite later duplicate snapshots', async () => {
  const sent = [];
  const cookieUpdates = [];
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
    getCookies() { return { c_user: accountId, xs: 'refreshed-session' }; }
    async disconnect() { this.connected = false; }
    async sendMessage(id, payload) { sent.push({ id, payload }); }
  }
  const listener = startMessengerListener({ cookies: `c_user=${accountId}; xs=test`, threadId,
    onCookiesUpdated: (cookies) => cookieUpdates.push(cookies) }, FakeClient,
    { retryMs: 10, snapshotRefreshMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(connections >= 3, 'a later snapshot must replay the same message for dedup verification');
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.text, /Send !buff followed by skin names/);
    assert.deepEqual(cookieUpdates, [`c_user=${accountId}; xs=refreshed-session`]);
  } finally { listener.stop(); }
});

test('refresh waits for a reply, then records the handled message for worker restarts', async () => {
  let releaseSend;
  let connections = 0;
  let sends = 0;
  const handled = [];
  const fresh = { id: 'fresh-reply', threadId: BigInt(threadId), senderId: 999n,
    text: '!buff', timestampMs: BigInt(Date.now()) };
  class SlowClient extends EventEmitter {
    connected = false;
    get isConnected() { return this.connected; }
    async connect() {
      this.connected = true;
      connections++;
      return { user: { id: BigInt(accountId) }, initialData: {
        threads: [{ id: BigInt(threadId), type: 2 }], messages: [fresh],
      } };
    }
    getCookies() { return { c_user: accountId, xs: 'test' }; }
    async disconnect() { this.connected = false; }
    async sendMessage() {
      sends++;
      if (sends === 1) await new Promise((resolve) => { releaseSend = resolve; });
    }
  }
  const listener = startMessengerListener({ cookies: `c_user=${accountId}; xs=test`, threadId,
    onMessageHandled: (id) => handled.push(id) }, SlowClient, { retryMs: 10, snapshotRefreshMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(connections, 1, 'do not disconnect the client while its reply is pending');
    assert.deepEqual(handled, []);
    releaseSend();
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.ok(connections >= 2);
    assert.equal(sends, 1);
    assert.deepEqual(handled, ['fresh-reply']);
  } finally { releaseSend?.(); await listener.stop(); }

  const replayed = [];
  const restarted = startMessengerListener({ cookies: `c_user=${accountId}; xs=test`, threadId,
    startedAt: Date.now() - 120_000, recentMessageIds: handled }, class extends SlowClient {
    async sendMessage() { replayed.push(true); }
  }, { retryMs: 10, snapshotRefreshMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(replayed, [], 'a restarted worker must not answer an already handled request');
  } finally { await restarted.stop(); }
});

test('failed Messenger send is retried from the next inbox snapshot', async () => {
  let sends = 0;
  const handled = [];
  const fresh = { id: 'retry-this', threadId: BigInt(threadId), senderId: 999n,
    text: '!buff', timestampMs: BigInt(Date.now()) };
  class FailingClient extends EventEmitter {
    connected = false;
    get isConnected() { return this.connected; }
    async connect() {
      this.connected = true;
      return { user: { id: BigInt(accountId) }, initialData: {
        threads: [{ id: BigInt(threadId), type: 2 }], messages: [fresh],
      } };
    }
    getCookies() { return { c_user: accountId, xs: 'test' }; }
    async disconnect() { this.connected = false; }
    async sendMessage() {
      sends++;
      if (sends === 1) throw new Error('temporary send failure');
    }
  }
  const listener = startMessengerListener({ cookies: `c_user=${accountId}; xs=test`, threadId,
    onMessageHandled: (id) => handled.push(id) }, FailingClient, { retryMs: 10, snapshotRefreshMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(sends, 2);
    assert.deepEqual(handled, ['retry-this']);
  } finally { await listener.stop(); }
});

test('invalid Messenger session backs off instead of retrying every tick', async () => {
  let attempts = 0;
  class InvalidSessionClient extends EventEmitter {
    get isConnected() { return false; }
    async connect() {
      attempts++;
      throw new Error('failed to load inbox: access token is no longer valid: user id in initial data is zero');
    }
    async disconnect() {}
  }
  const listener = startMessengerListener({ cookies: `c_user=${accountId}; xs=expired`, threadId },
    InvalidSessionClient, { retryMs: 5, authRetryInitialMs: 1_000 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(attempts, 1, 'do not retry an invalid session on each timer tick');
  } finally { await listener.stop(); }
});

test('reconnects when the live socket is not ready despite a connected flag', async () => {
  let connections = 0;
  class SocketDownClient extends EventEmitter {
    get isConnected() { return true; }
    isFullyReady() { return connections > 1; }
    async connect() {
      connections++;
      return { user: { id: BigInt(accountId) }, initialData: { threads: [], messages: [] } };
    }
    getCookies() { return { c_user: accountId, xs: 'test' }; }
    async disconnect() {}
  }
  const listener = startMessengerListener({ cookies: `c_user=${accountId}; xs=test`, threadId },
    SocketDownClient, { retryMs: 20, socketReadyGraceMs: 60, snapshotRefreshMs: 100_000 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(listener.status().connected, false, 'worker should not report a dead socket as ready');
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(connections, 1, 'initial database sync should have a grace period');
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(connections, 2, 'dead socket should reconnect before the snapshot refresh');
    assert.equal(listener.status().connected, true);
  } finally { await listener.stop(); }
});

test('can keep a fully ready socket connected when snapshot refresh is explicitly disabled', async () => {
  let connections = 0;
  let disconnects = 0;
  class ReadyClient extends EventEmitter {
    get isConnected() { return true; }
    isFullyReady() { return true; }
    async connect() {
      connections++;
      this.emit('fullyReady');
      return { user: { id: BigInt(accountId) }, initialData: { threads: [], messages: [] } };
    }
    getCookies() { return { c_user: accountId, xs: 'test' }; }
    async disconnect() { disconnects++; }
  }
  const listener = startMessengerListener({ cookies: `c_user=${accountId}; xs=test`, threadId },
    ReadyClient, { retryMs: 5, socketReadyGraceMs: 20, snapshotRefreshMs: Infinity });
  try {
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(connections, 1, 'a healthy socket must not be interrupted for an inbox snapshot');
    assert.equal(disconnects, 0);
    assert.equal(listener.status().connected, true);
  } finally { await listener.stop(); }
});

test('live LightSpeed upserts answer rapid target-thread requests once each', async () => {
  const sent = [];
  let client;
  class FakeClient extends EventEmitter {
    connected = false;
    get isConnected() { return this.connected; }
    async connect() {
      client = this;
      this.connected = true;
      return { user: { id: BigInt(accountId) }, initialData: { threads: [], messages: [] } };
    }
    getCookies() { return { c_user: accountId, xs: 'test' }; }
    async disconnect() { this.connected = false; }
    async sendMessage(id, payload) { sent.push({ id, payload }); }
  }
  const listener = startMessengerListener({ cookies: `c_user=${accountId}; xs=test`, threadId,
    lookup: async () => ['Price check result'] },
    FakeClient, { retryMs: 100_000, snapshotRefreshMs: 100_000 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const timestampMs = BigInt(Date.now());
    const other = { MessageId: 'competitor-1', ThreadKey: 888n, SenderId: 999n,
      Text: '!buff', TimestampMs: timestampMs };
    const upsert = { MessageId: 'target-1', ThreadKey: BigInt(threadId), SenderId: 999n,
      Text: '@BUFF BOT PRICE CHECKER ak bthemonster mw', TimestampMs: timestampMs };
    const second = { MessageId: 'target-2', ThreadKey: BigInt(threadId), SenderId: 999n,
      Text: '@Thang Manh Nguyen m9 gamma doppler p2', TimestampMs: timestampMs + 1n };
    client.emit('raw', { from: 'lightspeed', type: 'Event_PublishResponse', data: {
      Table: { LSUpsertMessage: [other, second, upsert] },
    } });
    client.emit('message', { id: upsert.MessageId, threadId: upsert.ThreadKey,
      senderId: upsert.SenderId, text: upsert.Text, timestampMs });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sent.length, 2);
    assert.ok(sent.every((message) => message.id === BigInt(threadId)));
    assert.ok(sent.every((message) => !/competitor/.test(message.payload.text)));
  } finally { await listener.stop(); }
});
