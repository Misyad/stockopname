import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.textContent = '';
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

const document = { createElement: (tagName) => new Element(tagName) };
const text = (node) => `${node.textContent}${node.children.map(text).join('')}`;

test('master shell links to import preview', async () => {
  const html = await readFile(new URL('../../src/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<a[^>]+href="\/imports"[^>]*>Import<\/a>/i);
});

test('import UI is semantic preview-only workflow', async () => {
  const [html, styles] = await Promise.all([
    readFile(new URL('../../src/public/import.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/public/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /<html[^>]+lang="id"/i);
  assert.match(html, /<form[^>]+id="import-form"/);
  assert.match(styles, /\.field\s*>\s*\*\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);

  assert.match(html, /<label[^>]+for="import-type"/i);
  assert.match(html, /<label[^>]+for="import-file"/i);
  assert.match(html, /type="file"[^>]+accept="\.csv,text\/csv"/i);
  assert.match(html, /id="preview-status"[^>]+role="status"[^>]+aria-live="polite"/i);
  assert.match(html, /id="preview-errors"[^>]+role="alert"/i);
  assert.doesNotMatch(html, /Konfirmasi|Confirm|\/confirm/i);
});

test('import client hashes exact UTF-8 content and renders untrusted values safely', async () => {
  const { renderPreview, sha256Text } = await import('../../src/public/import.js');
  assert.equal(
    await sha256Text('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const body = new Element('tbody');
  renderPreview(document, body, [{
    rowNumber: 2,
    code: '<img src=x onerror=alert(1)>',
    status: 'REVIEW',
    errors: [{ code: 'INVALID_PRODUCT', message: 'Tidak dikenal' }],
  }]);
  assert.match(text(body), /<img src=x onerror=alert\(1\)>/);
  assert.equal(body.children[0].children[1].textContent, 'code: <img src=x onerror=alert(1)>');
});

test('import client uses authenticated CSRF preview API without credential persistence or confirm', async () => {
  const source = await readFile(new URL('../../src/public/import.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/auth\/me/);
  assert.match(source, /\/api\/auth\/csrf/);
  assert.match(source, /\/api\/imports\/preview/);
  assert.match(source, /x-csrf-token/);
  assert.match(source, /crypto\.subtle\.digest/);
  assert.match(source, /role\s*!==\s*['"]ADMIN['"]/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|\/confirm/);
});
