import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { startMessengerSupervisor } from '../messenger-supervisor.mjs';

test('Messenger worker recycles without overlap and retains handled message IDs', async () => {
  const children = [];
  let active = 0;
  let maxActive = 0;
  class FakeChild extends EventEmitter {
    messages = [];
    exited = false;
    send(message) {
      this.messages.push(message);
      if (message.type === 'start') queueMicrotask(() => this.emit('message', { type: 'ready' }));
      if (message.type === 'stop') setTimeout(() => this.exit(0, null), 2);
    }
    kill(signal) { this.exit(null, signal); }
    exit(code, signal) {
      if (this.exited) return;
      this.exited = true;
      active--;
      this.emit('exit', code, signal);
    }
  }
  const supervisor = startMessengerSupervisor(
    { cookies: 'c_user=123; xs=old-session', threadId: 'approved-group', geminiKey: 'test-key' },
    {
      fork: (_path, _args, options) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const child = new FakeChild();
        child.environment = options.env;
        children.push(child);
        return child;
      },
      recycleMs: 25,
      restartBaseMs: 2,
      stopGraceMs: 50,
    },
  );
  try {
    children[0].emit('message', { type: 'handled', id: 'already-sent' });
    children[0].emit('message', { type: 'cookies', cookies: 'c_user=another-account; xs=wrong' });
    children[0].emit('message', { type: 'cookies', cookies: 'c_user=123' });
    for (let attempt = 0; attempt < 40 && children.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(children.length >= 2);
    assert.equal(maxActive, 1);
    assert.ok(children[0].messages.some((message) => message.type === 'stop'));
    assert.ok(children[1].messages[0].recentMessageIds.includes('already-sent'));
    assert.equal(children[1].messages[0].startedAt, children[0].messages[0].startedAt);
    assert.equal(children[1].environment.MESSENGER_COOKIES, 'c_user=123; xs=old-session');
    children[1].emit('message', { type: 'cookies', cookies: 'c_user=123; xs=refreshed-session' });
    for (let attempt = 0; attempt < 40 && children.length < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(children.length >= 3);
    assert.equal(children[2].environment.MESSENGER_COOKIES, 'c_user=123; xs=refreshed-session');
  } finally {
    await supervisor.stop();
  }
  assert.equal(active, 0);
});

test('stopping before a failed worker restart prevents another spawn', async () => {
  const children = [];
  class FakeChild extends EventEmitter {
    send() {}
    kill(signal) { this.emit('exit', null, signal); }
  }
  const supervisor = startMessengerSupervisor(
    { cookies: 'c_user=123; xs=old-session', threadId: 'approved-group' },
    { fork: () => { const child = new FakeChild(); children.push(child); return child; }, restartBaseMs: 15 },
  );
  children[0].emit('exit', 1, null);
  await supervisor.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(children.length, 1);
});
