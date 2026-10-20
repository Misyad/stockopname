import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderOpnameItems } from '../../src/public/opname.js';

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

function text(node) {
  return `${node.textContent}${node.children.map(text).join('')}`;
}

test('OP-002 PETUGAS count DOM omits system quantity and difference', () => {
  const body = new Element('tbody');
  renderOpnameItems(document, body, 'PETUGAS', [{
    id: 'item-1', productName: 'Beras', batchNumber: 'B-1', unit: 'kg',
    physicalQuantity: null, systemQuantity: '10', difference: '-1', differenceValue: '-5000',
  }]);
  assert.deepEqual(body.children[0].children.map(text), ['Beras', 'B-1', 'kg', '']);
});

test('SUPERVISOR count DOM may show system quantity and difference', () => {
  const body = new Element('tbody');
  renderOpnameItems(document, body, 'SUPERVISOR', [{
    id: 'item-1', productName: 'Beras', batchNumber: 'B-1', unit: 'kg',
    physicalQuantity: '9', systemQuantity: '10', difference: '-1', differenceValue: '-5000',
  }]);
  const dom = text(body);
  assert.match(dom, /10/);
  assert.match(dom, /-1/);
});
