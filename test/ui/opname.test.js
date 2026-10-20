import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approvalFailureMessage, renderOpnameItems, renderOpnameReview,
} from '../../src/public/opname.js';

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

test('review DOM shows evidence and movement errors offer no force approval', () => {
  const body = new Element('tbody');
  renderOpnameReview(document, body, [{
    productName: 'Beras', systemQuantity: '120', physicalQuantity: '118',
    difference: '-2', differenceValue: '-10000', reason: 'Rusak',
  }]);
  assert.deepEqual(body.children[0].children.map(text), [
    'Beras', '120', '118', '-2', '-10000', 'Rusak',
  ]);
  for (const code of ['STOCK_MOVED_DURING_OPNAME', 'STOCK_CHANGED_AFTER_OPNAME']) {
    assert.match(approvalFailureMessage(code), /recount|opname baru/i);
    assert.match(approvalFailureMessage(code), /force approve tidak tersedia/i);
  }
});
