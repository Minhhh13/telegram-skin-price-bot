import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dependencyRoot = join(packageRoot, 'node_modules', 'meta-messenger.js');
const bundlePath = join(dependencyRoot, 'dist', 'index.js');
const idlePoll = 'if (!event || event.type === "timeout") continue;';
const pacedPoll = 'if (!event || event.type === "timeout") {\n            await new Promise((resolve) => setTimeout(resolve, 75));\n            continue;\n          }';
const errorPoll = 'if (this.eventLoopRunning) {\n            this.emit("error", err);\n          }';
const pacedErrorPoll = 'if (this.eventLoopRunning) {\n            this.emit("error", err);\n            await new Promise((resolve) => setTimeout(resolve, 75));\n          }';

function replaceExactlyOnce(source, original, replacement) {
  if (source.includes(replacement)) return source;
  if (source.split(original).length !== 2) {
    throw new Error('meta-messenger.js event loop changed; review the idle-poll patch before installing');
  }
  return source.replace(original, replacement);
}

export function patchMessengerSource(source) {
  return replaceExactlyOnce(replaceExactlyOnce(source, idlePoll, pacedPoll), errorPoll, pacedErrorPoll);
}

export async function patchInstalledMessenger() {
  const manifest = JSON.parse(await readFile(join(dependencyRoot, 'package.json'), 'utf8'));
  if (manifest.version !== '1.1.3') {
    throw new Error(`Expected meta-messenger.js 1.1.3, found ${manifest.version}; review the patch`);
  }
  const original = await readFile(bundlePath, 'utf8');
  const patched = patchMessengerSource(original);
  if (patched !== original) {
    await writeFile(bundlePath, patched);
    console.log('Paced meta-messenger.js empty event polls at 75 ms');
  } else {
    console.log('meta-messenger.js event poll is already paced');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchInstalledMessenger();
}
