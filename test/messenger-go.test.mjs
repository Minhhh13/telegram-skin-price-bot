import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { startGoMessengerListener } from '../messenger-go.mjs';

function fakeSidecar() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0, 'SIGTERM')); };
  return child;
}

test('Go sidecar routes one approved Messenger request through the shared lookup and send path', async () => {
  const child = fakeSidecar();
  const listener = startGoMessengerListener({
    cookies: 'c_user=123; xs=fake; datr=fake', threadId: '456', geminiKey: '',
  }, {
    spawn: () => child,
    lookup: async () => ['**BUFF163 base prices · CNY → VND**\n\n**AK-47 | Redline (Field-Tested)**'],
  });
  const event = {
    type: 'message', source: 'snapshot', message_id: 'm1', thread_id: '456',
    sender_id: '789', timestamp_ms: Date.now(), text: '!buff ak redline ft',
  };
  const firstSend = once(child.stdin, 'data');
  child.stdout.write(`${JSON.stringify(event)}\n`);
  const [data] = await firstSend;
  const command = JSON.parse(String(data));
  assert.equal(command.thread_id, '456');
  assert.equal(command.reply_to, 'm1');
  assert.match(command.text, /AK-47 \| Redline/);
  const acknowledgment = once(child.stdin, 'data');
  child.stdout.write(`${JSON.stringify({ type: 'sent', request_id: command.request_id, ok: true })}\n`);
  const [ackData] = await acknowledgment;
  assert.deepEqual(JSON.parse(String(ackData)), { type: 'ack', message_id: 'm1' });

  child.stdout.write(`${JSON.stringify(event)}\n`);
  child.stdout.write(`${JSON.stringify({ ...event, message_id: 'm2', thread_id: 'other' })}\n`);
  child.stdout.write(`${JSON.stringify({ ...event, message_id: 'old', timestamp_ms: Date.now() - 60_000 })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(listener.status().handledMessageCount, 1);
  await listener.stop();
});

test('Go sidecar acknowledges ordinary group chatter without looking up a price', async () => {
  const child = fakeSidecar();
  let lookups = 0;
  const listener = startGoMessengerListener({
    cookies: 'c_user=123; xs=fake; datr=fake', threadId: '456', geminiKey: '',
  }, {
    spawn: () => child,
    lookup: async () => { lookups++; return []; },
  });
  const acknowledgment = once(child.stdin, 'data');
  child.stdout.write(`${JSON.stringify({
    type: 'message', source: 'snapshot', message_id: 'chatter', thread_id: '456',
    sender_id: '789', timestamp_ms: Date.now(), text: 'hello team',
  })}\n`);
  const [ackData] = await acknowledgment;
  assert.deepEqual(JSON.parse(String(ackData)), { type: 'ack', message_id: 'chatter' });
  assert.equal(lookups, 0);
  await listener.stop();
});

test('Go sidecar forwards an approved photo caption to the shared image lookup', async (t) => {
  const child = fakeSidecar();
  const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  t.mock.method(globalThis, 'fetch', async () => new Response(imageBytes, { status: 200 }));
  let receivedImage = null;
  const listener = startGoMessengerListener({
    cookies: 'c_user=123; xs=fake; datr=fake', threadId: '456', geminiKey: 'test',
  }, {
    spawn: () => child,
    lookup: async (_text, image) => {
      receivedImage = image;
      return ['**BUFF163 base prices · CNY → VND**'];
    },
  });
  const send = once(child.stdin, 'data');
  child.stdout.write(`${JSON.stringify({
    type: 'message', source: 'snapshot', message_id: 'photo1', thread_id: '456',
    sender_id: '789', timestamp_ms: Date.now(), text: '!buff',
    attachments: [{ type: 'image', url: 'https://image.fbcdn.net/photo.jpg' }],
  })}\n`);
  const [data] = await send;
  assert.equal(receivedImage?.mimeType, 'image/png');
  child.stdout.write(`${JSON.stringify({ type: 'sent', request_id: JSON.parse(String(data)).request_id, ok: true })}\n`);
  await listener.stop();
});
