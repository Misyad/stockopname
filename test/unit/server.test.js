import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

async function reservePort() {
  const probe = createTcpServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, child, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    assert.equal(child.exitCode, null, stderr() || 'Server exited before becoming healthy.');
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.fail('Server did not become healthy within 2 seconds.');
}

test('GET /health returns {success:true}', async (t) => {
  const port = await reservePort();
  let errorOutput = '';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errorOutput += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  const response = await waitForHealth(`http://127.0.0.1:${port}/health`, child, () => errorOutput);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  assert.deepEqual(await response.json(), { success: true });
});
