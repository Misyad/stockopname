const form = document.querySelector('#report-filters');
const status = document.querySelector('#screen-status');
const results = document.querySelector('#results');
const empty = document.querySelector('#empty-state');
const error = document.querySelector('#error-state');
const previous = document.querySelector('#previous-page');
const next = document.querySelector('#next-page');
let page = 1;
let requestId = 0;

const labels = Object.freeze({
  productCode: 'Kode barang', productName: 'Nama barang', categoryCode: 'Kategori',
  warehouseCode: 'Gudang', quantity: 'Jumlah', unit: 'Satuan', minimumStock: 'Minimum',
  maximumStock: 'Maksimum', status: 'Status', date: 'Tanggal', transactionType: 'Jenis',
  transactionNumber: 'Nomor transaksi', reference: 'Referensi', supplierCode: 'Supplier',
  batchId: 'ID batch', batchNumber: 'Nomor batch', balanceAfter: 'Saldo akhir',
  runningBalance: 'Saldo berjalan', userName: 'Pengguna', reason: 'Alasan',
  opnameNumber: 'Nomor opname', warehouseName: 'Nama gudang', snapshotVersion: 'Versi snapshot',
  submittedAt: 'Dikirim', approvedAt: 'Disetujui', productionDate: 'Tanggal produksi',
  expiryDate: 'Kedaluwarsa', expiryStatus: 'Status kedaluwarsa', systemQuantity: 'Jumlah sistem',
  physicalQuantity: 'Jumlah fisik', difference: 'Selisih', differenceValue: 'Nilai selisih',
});

function query() {
  const params = new URLSearchParams(new FormData(form));
  const type = params.get('type');
  params.delete('type');
  for (const [key, value] of [...params]) if (!value) params.delete(key);
  return { type, params };
}

function setState(name, message = '') {
  status.textContent = message;
  error.hidden = name !== 'error';
  empty.hidden = name !== 'empty';
  results.hidden = name !== 'ready';
}

function render(data) {
  const head = document.querySelector('#table-head');
  const body = document.querySelector('#table-body');
  head.replaceChildren();
  body.replaceChildren();
  if (!data.items.length) {
    setState('empty', 'Tidak ada data.');
    return;
  }
  const columns = Object.keys(data.items[0]).filter((key) => !key.endsWith('Id') && key !== 'id');
  for (const key of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = labels[key] || key;
    head.append(th);
  }
  for (const item of data.items) {
    const row = document.createElement('tr');
    for (const key of columns) {
      const td = document.createElement('td');
      td.textContent = item[key] ?? '—';
      row.append(td);
    }
    body.append(row);
  }
  document.querySelector('#page-summary').textContent = `Halaman ${data.page} · ${data.total} data`;
  previous.disabled = data.page <= 1;
  next.disabled = !data.hasNext;
  setState('ready', 'Laporan termuat.');
}

async function load() {
  const current = ++requestId;
  const { type, params } = query();
  params.set('page', String(page));
  params.set('limit', '50');
  const base = `/api/reports/${type}`;
  const exportParams = new URLSearchParams(params);
  exportParams.delete('page');
  exportParams.delete('limit');
  document.querySelector('#export-link').href = `${base}/export?${exportParams}`;
  status.textContent = 'Memuat laporan…';
  previous.disabled = true;
  next.disabled = true;
  try {
    const response = await fetch(`${base}?${params}`, { credentials: 'same-origin' });
    const payload = await response.json();
    if (response.status === 401) {
      location.assign('/login');
      return;
    }
    if (!response.ok) throw new Error(payload.message || 'Permintaan gagal.');
    if (current === requestId) render(payload.data);
  } catch (cause) {
    if (current !== requestId) return;
    document.querySelector('#error-message').textContent = cause instanceof TypeError
      ? 'Tidak dapat menghubungi server.' : cause.message;
    setState('error', 'Laporan gagal dimuat.');
  }
}

form.addEventListener('submit', (event) => { event.preventDefault(); page = 1; load(); });
previous.addEventListener('click', () => { page -= 1; load(); });
next.addEventListener('click', () => { page += 1; load(); });
load();
