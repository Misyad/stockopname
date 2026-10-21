const required = Object.freeze({ required: true });
const commonFields = Object.freeze([
  { name: 'date', label: 'Tanggal', type: 'date', ...required },
  { name: 'reference', label: 'Referensi', ...required },
  { name: 'warehouse', label: 'Gudang', ...required },
  { name: 'code', label: 'Barang', ...required },
  { name: 'quantity', label: 'Jumlah', type: 'number', step: 'any', min: '0', ...required },
  { name: 'unit', label: 'Satuan', ...required },
]);
const batchFields = Object.freeze([
  { name: 'batch', label: 'Batch' },
  { name: 'production_date', label: 'Tanggal produksi', type: 'date' },
  { name: 'expiry', label: 'Kedaluwarsa', type: 'date' },
  { name: 'price', label: 'Harga beli', type: 'number', step: 'any', min: '0' },
]);
const configs = Object.freeze({
  opening: {
    title: 'Stok Awal', endpoint: '/api/transactions/opening', adminOnly: true,
    fields: [...commonFields, ...batchFields, { name: 'notes', label: 'Catatan' }],
  },
  in: {
    title: 'Barang Masuk', endpoint: '/api/transactions/in', adminOnly: false,
    fields: [
      ...commonFields.slice(0, 2), { name: 'supplier', label: 'Supplier' },
      ...commonFields.slice(2), ...batchFields, { name: 'notes', label: 'Catatan' },
    ],
  },
  out: {
    title: 'Barang Keluar', endpoint: '/api/transactions/out', adminOnly: false,
    fields: [...commonFields, { name: 'notes', label: 'Alasan / catatan' }],
  },
});

export function transactionConfig(pathname) {
  return configs[pathname.split('/').filter(Boolean).at(-1)] ?? null;
}

export function prepareSubmission(entries, previous, keyFactory = () => crypto.randomUUID()) {
  const core = Object.fromEntries([...entries].filter(([, value]) => value !== ''));
  const fingerprint = JSON.stringify(core);
  const idempotencyKey = previous?.fingerprint === fingerprint
    ? previous.idempotencyKey : keyFactory();
  return { fingerprint, idempotencyKey, payload: { idempotencyKey, ...core } };
}

function displayValue(value) {
  return value === '' || value === null || value === undefined ? '—' : String(value);
}

if (typeof document !== 'undefined') {
  const config = transactionConfig(location.pathname);
  const title = document.querySelector('#page-title');
  const form = document.querySelector('#transaction-form');
  const fields = document.querySelector('#transaction-fields');
  const formError = document.querySelector('#form-error');
  const dialog = document.querySelector('#confirm-dialog');
  const review = document.querySelector('#review-summary');
  const confirmError = document.querySelector('#confirm-error');
  const confirmButton = document.querySelector('#confirm-button');
  const cancelButton = document.querySelector('#cancel-button');
  const receipt = document.querySelector('#receipt');
  let csrfToken;
  let role;
  let committing = false;
  let prepared = null;

  function fieldElement(field) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = `field-${field.name}`;
    label.textContent = field.label;
    const input = field.name === 'notes'
      ? document.createElement('textarea') : document.createElement('input');
    input.id = `field-${field.name}`;
    input.name = field.name;
    input.required = Boolean(field.required);
    if (field.type) input.type = field.type;
    if (field.step) input.step = field.step;
    if (field.min) input.min = field.min;
    if (field.name === 'date') input.value = new Date().toISOString().slice(0, 10);
    wrapper.append(label, input);
    return wrapper;
  }

  function summary(target, entries) {
    target.replaceChildren();
    for (const [name, value] of entries) {
      if (name === 'idempotencyKey') continue;
      const label = config.fields.find((field) => field.name === name)?.label ?? name;
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = displayValue(value);
      target.append(term, detail);
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const payload = await response.json();
    if (response.status === 401) {
      location.assign('/login');
      throw new Error('Sesi berakhir. Silakan masuk kembali.');
    }
    if (!response.ok) throw new Error(payload.message || 'Permintaan gagal.');
    return payload.data;
  }

  function closeDialog() {
    if (committing) return;
    dialog.close();
  }

  async function bootstrap() {
    try {
      const profile = await api('/api/auth/me');
      role = profile.role;
      for (const item of document.querySelectorAll('[data-admin-only]')) {
        item.hidden = role !== 'ADMIN';
      }
      if (config.adminOnly && role !== 'ADMIN') {
        formError.textContent = 'Akses ditolak. Stok awal hanya untuk ADMIN.';
        formError.hidden = false;
        return;
      }
      csrfToken = (await api('/api/auth/csrf')).csrfToken;
      form.hidden = false;
      title.focus();
    } catch (cause) {
      formError.textContent = cause.message;
      formError.hidden = false;
    }
  }

  title.textContent = config.title;
  document.title = `${config.title} — Stock Opname`;
  fields.replaceChildren(...config.fields.map(fieldElement));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    formError.hidden = true;
    const quantity = Number(new FormData(form).get('quantity'));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      formError.textContent = 'Jumlah harus lebih dari 0.';
      formError.hidden = false;
      return;
    }
    prepared = prepareSubmission(new FormData(form), prepared);
    summary(review, Object.entries(prepared.payload));
    confirmError.hidden = true;
    dialog.showModal();
    cancelButton.focus();
  });

  cancelButton.addEventListener('click', closeDialog);
  dialog.addEventListener('cancel', (event) => {
    if (committing) event.preventDefault();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener('close', () => document.querySelector('#review-button').focus());
  confirmButton.addEventListener('click', async () => {
    if (committing || !prepared) return;
    committing = true;
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    confirmError.hidden = true;
    try {
      const data = await api(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify(prepared.payload),
      });
      dialog.close();
      form.hidden = true;
      summary(document.querySelector('#receipt-data'), Object.entries(data));
      receipt.hidden = false;
      document.querySelector('#receipt-title').focus();
    } catch (cause) {
      confirmError.textContent = cause instanceof TypeError
        ? 'Hasil belum diketahui. Periksa transaksi atau coba lagi dengan data yang sama.'
        : cause.message;
      confirmError.hidden = false;
    } finally {
      committing = false;
      confirmButton.disabled = false;
      cancelButton.disabled = false;
    }
  });

  bootstrap();
}
