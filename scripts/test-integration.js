import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directories = ['integration', 'security']
  .map((name) => fileURLToPath(new URL(`../test/${name}/`, import.meta.url)));
const selector = process.argv.slice(2).find((argument) => argument !== '--');
const files = directories.flatMap((directory) => readdirSync(directory)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => !selector || name.includes(selector))
  .map((name) => `${directory}${name}`));

if (files.length === 0) {
  throw new Error(`No integration tests match: ${selector}`);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
