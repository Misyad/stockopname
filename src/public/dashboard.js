const fields = Object.freeze({
  total_products: 'total-products',
  total_stock: 'total-stock',
  safe: 'safe-stock',
  low: 'low-stock',
  out: 'out-stock',
  expired: 'expired',
  expiring_7d: 'expiring-7d',
  expiring_30d: 'expiring-30d',
  pending_opnames: 'pending-opnames',
  total_adjustment: 'total-adjustment',
});

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

function cell(value) {
  const td = document.createElement('td');
  td.textContent = value ?? '—';
  return td;
}

function render(data) {
  for (const [key, id] of Object.entries(fields)) {
    document.querySelector(`#${id}`).textContent = data[key] ?? '0';
  }
  const body = document.querySelector('#recent-body');
  body.replaceChildren();
  for (const item of data.recent_transactions) {
    const row = document.createElement('tr');
    row.append(
      cell(item.date), cell(item.transactionType), cell(item.reference),
      cell(`${item.productCode} · ${item.productName}`), cell(item.warehouseCode),
      cell(`${item.quantity} ${item.unit}`),
    );
    body.append(row);
  }
  document.querySelector('#recent-empty').hidden = data.recent_transactions.length !== 0;
  document.querySelector('#metrics').hidden = false;
  document.querySelector('#recent-transactions').hidden = false;
}

async function load() {
  const status = document.querySelector('#screen-status');
  const error = document.querySelector('#error-state');
  try {
    await api('/api/auth/me');
    render(await api('/api/dashboard'));
    status.textContent = 'Dashboard termuat.';
  } catch (cause) {
    document.querySelector('#error-message').textContent = cause instanceof TypeError
      ? 'Tidak dapat menghubungi server.' : cause.message;
    error.hidden = false;
    status.textContent = 'Dashboard gagal dimuat.';
  }
}

load();
