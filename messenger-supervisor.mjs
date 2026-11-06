import { fork } from 'node:child_process';

const RECYCLE_MS = 18 * 60_000;
const STOP_GRACE_MS = 10_000;
const MAX_HANDLED_IDS = 2_000;

export function startMessengerSupervisor(config, dependencies = {}) {
  if (!config.cookies || !config.threadId) {
    console.log('Messenger listener not configured');
    return null;
  }

  const forkWorker = dependencies.fork ?? fork;
  const schedule = dependencies.setTimeout ?? setTimeout;
  const cancel = dependencies.clearTimeout ?? clearTimeout;
  const now = dependencies.now ?? Date.now;
  const recycleMs = dependencies.recycleMs ?? RECYCLE_MS;
  const stopGraceMs = dependencies.stopGraceMs ?? STOP_GRACE_MS;
  const restartBaseMs = dependencies.restartBaseMs ?? 1_000;
  const startedAt = now() - 5_000;
  const handledIds = new Set();
  let worker = null;
  let recycleTimer = null;
  let restartTimer = null;
  let killTimer = null;
  let stopping = false;
  let workerStopRequested = false;
  let failures = 0;
  let stopPromise = null;
  let resolveStop = null;

  const clearTimers = () => {
    for (const timer of [recycleTimer, restartTimer, killTimer]) if (timer) cancel(timer);
    recycleTimer = restartTimer = killTimer = null;
  };

  const requestWorkerStop = (target) => {
    if (!target || workerStopRequested) return;
    workerStopRequested = true;
    if (recycleTimer) cancel(recycleTimer);
    recycleTimer = null;
    try { target.send({ type: 'stop' }); }
    catch { target.kill('SIGTERM'); }
    killTimer = schedule(() => {
      if (worker === target) target.kill('SIGKILL');
    }, stopGraceMs);
    killTimer?.unref?.();
  };

  const spawn = () => {
    if (stopping || worker) return;
    try {
      const environment = {
        ...process.env,
        MESSENGER_COOKIES: config.cookies,
        MESSENGER_THREAD_ID: config.threadId,
        GEMINI_API_KEY: config.geminiKey || '',
      };
      const child = forkWorker(new URL('./messenger-worker.mjs', import.meta.url), [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: environment,
        execArgv: [],
      });
      worker = child;
      workerStopRequested = false;
      child.on('message', (message) => {
        if (worker !== child || !message || typeof message !== 'object') return;
        if (message.type === 'ready') failures = 0;
        if (message.type === 'handled' && message.id) {
          handledIds.add(String(message.id));
          if (handledIds.size > MAX_HANDLED_IDS) handledIds.delete(handledIds.values().next().value);
        }
      });
      child.on('error', (error) => console.error('Messenger worker error:', error?.message || String(error)));
      child.on('exit', (code, signal) => {
        if (worker !== child) return;
        worker = null;
        workerStopRequested = false;
        clearTimers();
        if (stopping) {
          resolveStop?.();
          return;
        }
        failures++;
        const delay = Math.min(60_000, restartBaseMs * 2 ** Math.min(failures - 1, 6));
        console.warn('Messenger worker exited; restarting', { code, signal, delayMs: delay });
        restartTimer = schedule(spawn, delay);
        restartTimer?.unref?.();
      });
      child.send({ type: 'start', startedAt, recentMessageIds: [...handledIds] });
      recycleTimer = schedule(() => requestWorkerStop(child), recycleMs);
      recycleTimer?.unref?.();
    } catch (error) {
      try { worker?.kill('SIGTERM'); } catch { /* A failed spawn may not have a process. */ }
      worker = null;
      console.error('Messenger worker launch failed:', error instanceof Error ? error.message : String(error));
      failures++;
      const delay = Math.min(60_000, restartBaseMs * 2 ** Math.min(failures - 1, 6));
      restartTimer = schedule(spawn, delay);
      restartTimer?.unref?.();
    }
  };

  spawn();
  return {
    status: () => ({ running: Boolean(worker), handledMessageCount: handledIds.size }),
    stop: () => {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = new Promise((resolve) => { resolveStop = resolve; });
      if (restartTimer) cancel(restartTimer);
      restartTimer = null;
      if (worker) requestWorkerStop(worker);
      else resolveStop();
      return stopPromise;
    },
  };
}
