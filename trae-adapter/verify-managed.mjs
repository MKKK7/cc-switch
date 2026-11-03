// Optional live startup/lifetime check, reads the user's existing login.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const key = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
  windowsHide: true, env: { ...process.env, CC_TRAE_KEY: key, CC_TRAE_MANAGED: '1', CC_TRAE_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
});
const timer = setTimeout(() => child.kill(), 60000);
try {
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([once(lines, 'line'), once(child, 'exit').then(() => { throw new Error('Adapter exited before ready'); })]);
  const ready = JSON.parse(line);
  const response = await fetch(`http://127.0.0.1:${ready.port}/v1/models`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.length, ready.models.length);
  const exit = once(child, 'exit');
  child.stdin.end();
  const [code] = await exit;
  assert.equal(code, 0);
  console.log(JSON.stringify({ managedStartup: true, authenticatedModels: true, exitsWithParentPipe: true }));
} finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
