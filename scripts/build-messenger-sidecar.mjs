import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// The existing Render service uses a Node runtime and `npm ci` build command.
// Build the optional maintained Go Messenger bridge only when that backend is
// selected. The archive digest comes from the official go.dev/dl release page.
const GO_VERSION = '1.27.3';
const GO_SHA256 = '65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40';
const GO_ARCHIVE = `go${GO_VERSION}.linux-amd64.tar.gz`;
const shouldBuild = process.platform === 'linux' && process.arch === 'x64' &&
  (process.env.MESSENGER_BACKEND === 'go' || process.env.BUILD_MESSENGER_SIDECAR === '1');

if (!shouldBuild) {
  console.log('Maintained Messenger sidecar build skipped');
} else {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const source = join(root, 'prototype', 'messenger-sidecar');
  const destination = join(root, 'bin', 'messenger-sidecar');
  const temp = await mkdtemp(join(tmpdir(), 'skin-messenger-go-'));
  const archive = join(temp, GO_ARCHIVE);
  const run = (command, args, options = {}) => new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)));
  });
  try {
    const response = await fetch(`https://go.dev/dl/${GO_ARCHIVE}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`Go archive download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    const digest = createHash('sha256');
    await pipeline(createReadStream(archive), digest);
    if (digest.digest('hex') !== GO_SHA256) throw new Error('Go archive checksum mismatch');
    await run('tar', ['-xzf', archive, '-C', temp]);
    const go = join(temp, 'go', 'bin', 'go');
    const env = {
      ...process.env,
      GOTOOLCHAIN: 'local',
      CGO_ENABLED: '0',
      PATH: `${join(temp, 'go', 'bin')}:${process.env.PATH || ''}`,
    };
    await mkdir(join(root, 'bin'), { recursive: true });
    await run(go, ['build', '-mod=mod', '-trimpath', '-ldflags=-s -w', '-o', destination, '.'], { cwd: source, env });
    console.log('Maintained Messenger sidecar built');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
