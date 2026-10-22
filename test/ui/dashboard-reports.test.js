import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function source(name) {
  return readFile(new URL(`../../src/public/${name}`, import.meta.url), 'utf8');
}

test('dashboard screen is accessible and contains read-only cards and recent rows', async () => {
  const html = await source('dashboard.html');
  assert.match(html, /<html[^>]+lang="id"/i);
  assert.match(html, /id="dashboard-cards"/);
  assert.match(html, /id="recent-transactions"/);
  assert.match(html, /id="screen-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(html, /<button[^>]*(edit|delete|hapus|ubah)/i);
  const js = await source('dashboard.js');
  assert.match(js, /\/api\/dashboard/);
  assert.match(js, /textContent/);
  assert.doesNotMatch(js, /innerHTML|localStorage|sessionStorage|document\.cookie|method:\s*['"]POST/i);
});

test('reports screen keeps filters in URL and delegates CSV to streaming endpoint', async () => {
  const html = await source('reports.html');
  for (const id of ['report-type', 'filters', 'report-body', 'export-csv', 'screen-status']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const js = await source('reports.js');
  assert.match(js, /URLSearchParams/);
  assert.match(js, /history\.replaceState/);
  assert.match(js, /\/api\/reports\//);
  assert.match(js, /\/export\?format=CSV/);
  assert.match(js, /textContent/);
  assert.doesNotMatch(js, /innerHTML|localStorage|sessionStorage|document\.cookie/);
});

test('every authenticated shell links dashboard and reports', async () => {
  for (const name of ['index.html', 'inventory.html', 'transaction.html', 'import.html', 'opname.html']) {
    const html = await source(name);
    assert.match(html, /href="\/dashboard"/, name);
    assert.match(html, /href="\/reports"/, name);
  }
});
