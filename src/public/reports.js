const columns = Object.freeze({
  STOCK: [['productCode', 'Kode'], ['productName', 'Barang'], ['categoryName', 'Kategori'], ['warehouseCode', 'Gudang'], ['quantity', 'Jumlah'], ['unit', 'Satuan'], ['status', 'Status']],
  STOCK_CARD: [['date', 'Tanggal'], ['transactionNumber', 'Nomor'], ['transactionType', 'Tipe'], ['productCode', 'Barang'], ['warehouseCode', 'Gudang'], ['quantity', 'Jumlah'], ['balanceAfter', 'Saldo']],
  IN: [['date', 'Tanggal'], ['transactionNumber', 'Nomor'], ['reference', 'Referensi'], ['productCode', 'Barang'], ['warehouseCode', 'Gudang'], ['supplierName', 'Supplier'], ['quantity', 'Jumlah']],
  OUT: [['date', 'Tanggal'], ['transactionNumber', 'Nomor'], ['reference', 'Referensi'], ['productCode', 'Barang'], ['warehouseCode', 'Gudang'], ['quantity', 'Jumlah'], ['reason', 'Alasan']],
  ADJUSTMENT: [['date', 'Tanggal'], ['transactionNumber', 'Nomor'], ['reference', 'Referensi'], ['productCode', 'Barang'], ['warehouseCode', 'Gudang'], ['quantity', 'Jumlah'], ['reason', 'Alasan']],
  OPNAME: [['date', 'Tanggal'], ['opnameNumber', 'Nomor'], ['warehouseCode', 'Gudang'], ['status', 'Status'], ['creatorName', 'Pembuat']],
  OPNAME_DIFFERENCE: [['date', 'Tanggal'], ['opnameNumber', 'Nomor'], ['productCode', 'Barang'], ['warehouseCode', 'Gudang'], ['systemQuantity', 'Sistem'], ['physicalQuantity', 'Fisik'], ['difference', 'Selisih']],
  BATCH_EXPIRY: [['productCode', 'Barang'], ['warehouseCode', 'Gudang'], ['batchNumber', 'Batch'], ['expiryDate', 'Expired'], ['expiryStatus', 'Status expiry'], ['quantity', 'Jumlah']],
});
const form = document.querySelector('#filters');
const type = document.querySelector('#report-type');
const status = document.querySelector('#screen-status');
const results = document.querySelector('#results');
const empty = document.querySelector('#empty-state');
const error = document.querySelector('#error-state');
const previous = document.querySelector('#previous-page');
const next = document.querySelector('#next-page');
let page = 1;
let requestId = 0;

function params(includePage = true) {
  const value = new URLSearchParams(new FormData(form));
  value.delete('type');
  for (const [key, item] of [...value]) if (!item) value.delete(key);
  if (includePage) {
    value.set('page', String(page));
    value.set('limit', '50');
  }
  return value;
}

function setState(name, message = '') {
  status.hidden = name !== 'loading';
  status.textContent = message || 'Memuat data…';
  results.hidden = name !== 'ready';
  empty.hidden = name !== 'empty';
  error.hidden = name !== 'error';
}

function render(data) {
  const selected = columns[type.value];
  const head = document.querySelector('#report-head');
  const body = document.querySelector('#report-body');
  head.replaceChildren();
  body.replaceChildren();
  for (const [, label] of selected) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    head.append(cell);
  }
  for (const item of data.items) {
    const row = document.createElement('tr');
    for (const [key] of selected) {
      const cell = document.createElement('td');
      cell.textContent = item[key] ?? '—';
      row.append(cell);
    }
    body.append(row);
  }
  document.querySelector('#page-summary').textContent = `Halaman ${data.page} · ${data.total} data`;
  previous.disabled = data.page <= 1;
  next.disabled = !data.hasNext;
  setState(data.items.length ? 'ready' : 'empty');
}

async function load() {
  const current = ++requestId;
  setState('loading');
  previous.disabled = true;
  next.disabled = true;
  const url = new URL(location.href);
  url.search = params(false);
  url.searchParams.set('type', type.value);
  history.replaceState(null, '', url);
  try {
    const response = await fetch(`/api/reports/${type.value}?${params()}`, { credentials: 'same-origin' });
    const payload = await response.json();
    if (response.status === 401) return location.assign('/login');
    if (!response.ok) throw new Error(payload.message || 'Permintaan gagal.');
    if (current === requestId) render(payload.data);
  } catch (cause) {
    if (current !== requestId) return;
    document.querySelector('#error-message').textContent = cause.message;
    setState('error');
  }
}

function restore() {
  const query = new URLSearchParams(location.search);
  if (columns[query.get('type')]) type.value = query.get('type');
  for (const name of ['from', 'to', 'status']) {
    const control = form.elements.namedItem(name);
    if (query.has(name)) control.value = query.get(name);
  }
}

form.addEventListener('submit', (event) => { event.preventDefault(); page = 1; load(); });
type.addEventListener('change', () => { page = 1; load(); });
previous.addEventListener('click', () => { page -= 1; load(); });
next.addEventListener('click', () => { page += 1; load(); });
document.querySelector('#retry-button').addEventListener('click', load);
document.querySelector('#export-csv').addEventListener('click', () => {
  location.assign(`/api/reports/${type.value}/export?format=CSV&${params(false)}`);
});
restore();
load();
