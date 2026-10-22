const cards = Object.freeze([
  ['total_products', 'Total barang', '/stock'],
  ['total_stock', 'Total stok', null],
  ['safe', 'Stok aman', null],
  ['low', 'Stok rendah', null],
  ['out', 'Stok habis', null],
  ['expired', 'Expired', null],
  ['expiring_7d', 'Expired ≤ 7 hari', null],
  ['expiring_30d', 'Expired ≤ 30 hari', null],
  ['pending_opnames', 'Pending opname', '/opnames?status=SUBMITTED'],
  ['total_adjustment', 'Total adjustment', null],
]);

const status = document.querySelector('#screen-status');
const content = document.querySelector('#dashboard-content');
const error = document.querySelector('#error-state');

function setState(name, message = '') {
  status.hidden = name !== 'loading';
  status.textContent = message || 'Memuat data…';
  error.hidden = name !== 'error';
  content.hidden = name !== 'ready';
}

function metric([key, label, href], data) {
  const article = document.createElement('article');
  article.className = 'metric-card';
  const heading = document.createElement('h2');
  heading.textContent = label;
  const value = document.createElement('strong');
  value.textContent = data[key] ?? '0';
  article.append(heading, value);
  if (href) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = 'Lihat detail';
    article.append(link);
  }
  return article;
}

function render(data) {
  document.querySelector('#dashboard-cards').replaceChildren(...cards.map((card) => metric(card, data)));
  const body = document.querySelector('#recent-transactions');
  body.replaceChildren();
  for (const item of data.recent_transactions) {
    const row = document.createElement('tr');
    for (const value of [
      item.date, item.transactionNumber, item.transactionType,
      item.productName, item.warehouseCode, `${item.quantity} ${item.unit}`,
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value ?? '—';
      row.append(cell);
    }
    body.append(row);
  }
  setState('ready');
}

async function load() {
  setState('loading');
  try {
    const response = await fetch('/api/dashboard', { credentials: 'same-origin' });
    const payload = await response.json();
    if (response.status === 401) return location.assign('/login');
    if (!response.ok) throw new Error(payload.message || 'Permintaan gagal.');
    render(payload.data);
    document.querySelector('#page-title').focus();
  } catch (cause) {
    document.querySelector('#error-message').textContent = cause.message;
    setState('error');
  }
}

document.querySelector('#retry-button').addEventListener('click', load);
load();
