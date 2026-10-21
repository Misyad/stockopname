const stockColumns = Object.freeze([
  { key: 'productCode', label: 'Kode' },
  { key: 'productName', label: 'Barang' },
  { key: 'warehouseCode', label: 'Gudang' },
  { key: 'quantity', label: 'Jumlah' },
  { key: 'unit', label: 'Satuan' },
  { key: 'minimumStock', label: 'Minimum' },
  { key: 'status', label: 'Status' },
]);
const transactionColumns = Object.freeze([
  { key: 'date', label: 'Tanggal' },
  { key: 'transactionType', label: 'Tipe' },
  { key: 'transactionNumber', label: 'Nomor' },
  { key: 'reference', label: 'Referensi' },
  { key: 'productCode', label: 'Barang' },
  { key: 'warehouseCode', label: 'Gudang' },
  { key: 'quantity', label: 'Jumlah' },
  { key: 'unit', label: 'Satuan' },
  { key: 'balanceAfter', label: 'Saldo' },
  { key: 'userName', label: 'Petugas' },
]);
const cardColumns = Object.freeze([
  { key: 'date', label: 'Tanggal' },
  { key: 'transactionType', label: 'Tipe' },
  { key: 'reference', label: 'Referensi' },
  { key: 'batchId', label: 'Batch' },
  { key: 'quantity', label: 'Perubahan' },
  { key: 'unit', label: 'Satuan' },
  { key: 'runningBalance', label: 'Saldo berjalan' },
  { key: 'userName', label: 'Petugas' },
]);
const typeChoices = ['', 'IN', 'OUT', 'OPENING', 'ADJUSTMENT', 'REVERSAL'];

export function inventoryConfig(pathname) {
  if (pathname === '/stock') return {
    title: 'Stok', description: 'Saldo stok per barang dan gudang.', endpoint: '/api/stock',
    columns: stockColumns,
    filters: [
      { name: 'q', label: 'Cari barang / gudang' },
      { name: 'status', label: 'Status barang', choices: ['', 'ACTIVE', 'INACTIVE', 'REVIEW'] },
    ],
  };
  if (pathname === '/transactions') return {
    title: 'Transaksi', description: 'Ledger pergerakan stok. Data tidak dapat diedit.',
    endpoint: '/api/transactions', columns: transactionColumns,
    filters: [
      { name: 'q', label: 'Cari transaksi' },
      { name: 'type', label: 'Tipe', choices: typeChoices },
      { name: 'from', label: 'Dari', type: 'date' },
      { name: 'to', label: 'Sampai', type: 'date' },
    ],
  };
  const productId = pathname.match(/^\/stock-card\/([^/]+)$/)?.[1];
  if (!productId) return null;
  return {
    title: 'Kartu Stok', description: 'Riwayat dan saldo berjalan barang.',
    endpoint: `/api/stock-card/${encodeURIComponent(productId)}`, columns: cardColumns,
    filters: [
      { name: 'type', label: 'Tipe', choices: typeChoices },
      { name: 'from', label: 'Dari', type: 'date' },
      { name: 'to', label: 'Sampai', type: 'date' },
    ],
  };
}

if (typeof document !== 'undefined') {
  const config = inventoryConfig(location.pathname);
  const title = document.querySelector('#page-title');
  const description = document.querySelector('#page-description');
  const filters = document.querySelector('#filters');
  const status = document.querySelector('#screen-status');
  const error = document.querySelector('#error-state');
  const empty = document.querySelector('#empty-state');
  const results = document.querySelector('#results');
  const previous = document.querySelector('#previous-page');
  const next = document.querySelector('#next-page');
  let page = 1;
  let loadRequestId = 0;

  function filterField(field) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = `filter-${field.name}`;
    label.textContent = field.label;
    let control;
    if (field.choices) {
      control = document.createElement('select');
      for (const choice of field.choices) {
        const option = document.createElement('option');
        option.value = choice;
        option.textContent = choice || 'Semua';
        control.append(option);
      }
    } else {
      control = document.createElement('input');
      control.type = field.type || 'search';
    }
    control.id = `filter-${field.name}`;
    control.name = field.name;
    wrapper.append(label, control);
    return wrapper;
  }

  function setState(name, message = '') {
    status.hidden = name !== 'loading';
    status.textContent = message || 'Memuat data…';
    error.hidden = name !== 'error';
    empty.hidden = name !== 'empty';
    results.hidden = name !== 'ready';
  }

  function cell(row, column) {
    const td = document.createElement('td');
    if (location.pathname === '/stock' && column.key === 'productCode') {
      const link = document.createElement('a');
      link.href = `/stock-card/${encodeURIComponent(row.productId)}`;
      link.textContent = row[column.key] ?? '—';
      td.append(link);
    } else {
      td.textContent = row[column.key] ?? '—';
    }
    return td;
  }

  function render(data) {
    const head = document.querySelector('#table-head');
    const body = document.querySelector('#table-body');
    head.replaceChildren();
    body.replaceChildren();
    for (const column of config.columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = column.label;
      head.append(th);
    }
    for (const row of data.items) {
      const tr = document.createElement('tr');
      tr.append(...config.columns.map((column) => cell(row, column)));
      body.append(tr);
    }
    document.querySelector('#page-summary').textContent = `Halaman ${data.page} · ${data.total} data`;
    previous.disabled = data.page <= 1;
    next.disabled = !data.hasNext;
    setState(data.items.length ? 'ready' : 'empty');
  }

  async function api(path) {
    const response = await fetch(path, { credentials: 'same-origin' });
    const payload = await response.json();
    if (response.status === 401) {
      location.assign('/login');
      throw new Error('Sesi berakhir. Silakan masuk kembali.');
    }
    if (!response.ok) throw new Error(payload.message || 'Permintaan gagal.');
    return payload.data;
  }

  async function load() {
    const requestId = ++loadRequestId;
    setState('loading');
    previous.disabled = true;
    next.disabled = true;
    const params = new URLSearchParams(new FormData(filters));
    for (const [key, value] of [...params]) if (!value) params.delete(key);
    params.set('page', String(page));
    params.set('limit', '25');
    try {
      const data = await api(`${config.endpoint}?${params}`);
      if (requestId !== loadRequestId) return;
      render(data);
    } catch (cause) {
      if (requestId !== loadRequestId) return;
      document.querySelector('#error-message').textContent = cause.message;
      setState('error');
    }
  }

  async function bootstrap() {
    try {
      await api('/api/auth/me');
      await load();
      title.focus();
    } catch (cause) {
      document.querySelector('#error-message').textContent = cause.message;
      setState('error');
    }
  }

  title.textContent = config.title;
  description.textContent = config.description;
  document.title = `${config.title} — Stock Opname`;
  filters.replaceChildren(...config.filters.map(filterField));
  const apply = document.createElement('button');
  apply.className = 'primary';
  apply.type = 'submit';
  apply.textContent = 'Terapkan';
  filters.append(apply);
  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    page = 1;
    load();
  });
  document.querySelector('#retry-button').addEventListener('click', load);
  previous.addEventListener('click', () => { page -= 1; load(); });
  next.addEventListener('click', () => { page += 1; load(); });
  bootstrap();
}
