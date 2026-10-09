const required = Object.freeze({ required: true });
const configs = Object.freeze({
  products: {
    title: 'Barang',
    fields: [
      ['code', 'Kode', required], ['name', 'Nama', required], ['barcode', 'Barcode'],
      ['category_id', 'Kategori', { ...required, reference: 'categories' }],
      ['base_unit_id', 'Satuan dasar', { ...required, reference: 'units' }],
      ['purchase_unit_id', 'Satuan beli', { reference: 'units' }],
      ['conversion_factor', 'Faktor konversi', { ...required, type: 'number', step: 'any' }],
      ['minimum_stock', 'Stok minimum', { type: 'number', step: 'any' }],
      ['maximum_stock', 'Stok maksimum', { type: 'number', step: 'any' }],
      ['photo_url', 'URL foto', { type: 'url' }],
    ],
  },
  categories: { title: 'Kategori', fields: [['code', 'Kode', required], ['name', 'Nama', required]] },
  units: {
    title: 'Satuan',
    fields: [
      ['code', 'Kode', required], ['name', 'Nama', required], ['symbol', 'Simbol', required],
      ['base_unit_id', 'Satuan dasar', { reference: 'units' }],
      ['conversion_to_base', 'Konversi ke satuan dasar', { ...required, type: 'number', step: 'any' }],
    ],
  },
  'unit-aliases': {
    title: 'Alias Satuan',
    fields: [['alias', 'Alias', required], ['unit_id', 'Satuan', { ...required, reference: 'units' }]],
  },
  warehouses: {
    title: 'Gudang',
    fields: [['code', 'Kode', required], ['name', 'Nama', required], ['location', 'Lokasi']],
  },
  suppliers: {
    title: 'Supplier',
    fields: [
      ['code', 'Kode', required], ['name', 'Nama', required], ['phone', 'Telepon'], ['address', 'Alamat'],
    ],
  },
  users: {
    title: 'Pengguna',
    fields: [
      ['name', 'Nama', required], ['email', 'Email', { ...required, type: 'email' }],
      ['password', 'Password', { ...required, type: 'password', createOnly: true }],
      ['role', 'Role', { ...required, choices: ['ADMIN', 'SUPERVISOR', 'PETUGAS'] }],
    ],
    createOnly: true,
  },
});

export function createModalController(dialog, safeTarget) {
  let trigger;
  let committing = false;
  function close() {
    if (committing) return false;
    dialog.close();
    return true;
  }
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  dialog.addEventListener('close', () => trigger?.focus());
  return {
    open(source) {
      trigger = source;
      dialog.showModal();
      safeTarget.focus();
    },
    close,
    startCommit() {
      if (committing) return false;
      committing = true;
      return true;
    },
    finishCommit() { committing = false; },
  };
}

export async function openBuiltForm(build, controller, trigger, output) {
  output.hidden = true;
  try {
    await build();
    controller.open(trigger);
    return true;
  } catch (cause) {
    output.textContent = cause instanceof TypeError
      ? 'Tidak dapat memuat referensi. Coba lagi.'
      : cause.message;
    output.hidden = false;
    return false;
  }
}

export function formPayload(entries, fields, editing) {
  const requiredFields = new Set(fields.filter(([, , options]) => options?.required).map(([key]) => key));
  return Object.fromEntries([...entries]
    .filter(([key, value]) => value !== '' || (editing && !requiredFields.has(key)))
    .map(([key, value]) => [key, value === '' ? null : value]));
}

if (typeof document !== 'undefined') {
  const type = location.pathname.split('/').filter(Boolean).at(-1);
  const config = configs[type] || configs.categories;
  const title = document.querySelector('#page-title');
  const status = document.querySelector('#screen-status');
  const results = document.querySelector('#results');
  const empty = document.querySelector('#empty-state');
  const error = document.querySelector('#error-state');
  const createButton = document.querySelector('#create-button');
  const dialog = document.querySelector('#master-dialog');
  const cancelButton = document.querySelector('#cancel-button');
  const controller = createModalController(dialog, cancelButton);
  let csrfToken;
  let page = 1;
  let role;
  let editingId = null;
  let loadRequestId = 0;

  title.textContent = config.title;
  document.title = `${config.title} — Stock Opname`;

  function setState(name, message = '') {
    status.hidden = name !== 'loading';
    status.textContent = message || 'Memuat data…';
    error.hidden = name !== 'error';
    empty.hidden = name !== 'empty';
    results.hidden = name !== 'ready';
  }

  function cell(row, key) {
    const td = document.createElement('td');
    td.textContent = row[key] ?? '—';
    return td;
  }

  function actionButton(label, row, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => action(row, button));
    return button;
  }

  function render(data) {
    const head = document.querySelector('#table-head');
    const body = document.querySelector('#table-body');
    head.replaceChildren();
    body.replaceChildren();
    for (const [, label] of config.fields.filter(([, , options]) => !options?.createOnly)) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      head.append(th);
    }
    for (const label of ['Status', ...(role === 'ADMIN' ? ['Aksi'] : [])]) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      head.append(th);
    }
    for (const row of data.rows) {
      const tr = document.createElement('tr');
      for (const [key, , options] of config.fields) {
        if (!options?.createOnly) tr.append(cell(row, key));
      }
      tr.append(cell(row, 'status'));
      if (role === 'ADMIN') {
        const actions = document.createElement('td');
        if (!config.createOnly) actions.append(actionButton('Ubah', row, openEdit));
        if (row.status !== 'INACTIVE') actions.append(actionButton('Nonaktifkan', row, deactivate));
        tr.append(actions);
      }
      body.append(tr);
    }
    document.querySelector('#page-summary').textContent = `Halaman ${data.page} · ${data.total} data`;
    document.querySelector('#previous-page').disabled = data.page <= 1;
    document.querySelector('#next-page').disabled = data.page * data.limit >= data.total;
    setState(data.rows.length ? 'ready' : 'empty');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const payload = await response.json();
    if (response.status === 401) {
      location.assign('/login');
      throw new Error('Sesi berakhir. Silakan masuk kembali.');
    }
    if (response.status === 403) {
      throw new Error(payload.message || 'Akses ditolak.');
    }
    if (!response.ok) throw new Error(payload.message || 'Permintaan gagal.');
    return payload.data;
  }

  async function load() {
    const requestId = ++loadRequestId;
    setState('loading');
    document.querySelector('#previous-page').disabled = true;
    document.querySelector('#next-page').disabled = true;
    const params = new URLSearchParams(new FormData(document.querySelector('#filters')));
    params.set('page', String(page));
    params.set('limit', '25');
    try {
      const data = await api(`/api/${type}?${params}`);
      if (requestId !== loadRequestId) return;
      render(data);
    } catch (cause) {
      if (requestId !== loadRequestId) return;
      document.querySelector('#error-message').textContent = cause.message;
      setState('error');
    }
  }

  async function referenceSelect(key, options, value) {
    const select = document.createElement('select');
    select.id = `field-${key}`;
    select.name = key;
    select.required = Boolean(options.required);
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Pilih…';
    select.append(blank);
    const data = await api(`/api/${options.reference}?status=ACTIVE&limit=100`);
    for (const row of data.rows) {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = [row.code, row.name || row.alias].filter(Boolean).join(' · ');
      option.selected = row.id === value;
      select.append(option);
    }
    return select;
  }

  async function buildForm(row = null) {
    const fields = document.querySelector('#form-fields');
    fields.replaceChildren();
    for (const [key, labelText, options = {}] of config.fields) {
      if (row && options.createOnly) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'field';
      const label = document.createElement('label');
      label.htmlFor = `field-${key}`;
      label.textContent = labelText;
      let input;
      if (options.reference) {
        input = await referenceSelect(key, options, row?.[key]);
      } else if (options.choices) {
        input = document.createElement('select');
        for (const choice of options.choices) {
          const option = document.createElement('option');
          option.value = choice;
          option.textContent = choice;
          option.selected = row?.[key] === choice;
          input.append(option);
        }
      } else {
        input = document.createElement('input');
        input.type = options.type || 'text';
        if (options.step) input.step = options.step;
        input.value = row?.[key] ?? '';
      }
      input.id = `field-${key}`;
      input.name = key;
      input.required = Boolean(options.required);
      wrapper.append(label, input);
      fields.append(wrapper);
    }
  }

  async function openEdit(row, trigger) {
    editingId = row.id;
    document.querySelector('#form-title').textContent = `Ubah ${config.title}`;
    await openBuiltForm(
      () => buildForm(row),
      controller,
      trigger,
      status,
    );
  }

  async function deactivate(row) {
    if (!confirm(`Nonaktifkan ${row.name || row.alias || row.code}?`)) return;
    const path = type === 'users' ? `/api/users/${row.id}/status` : `/api/${type}/${row.id}`;
    try {
      await api(path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ status: 'INACTIVE' }),
      });
      await load();
      status.hidden = false;
      status.textContent = 'Data berhasil dinonaktifkan.';
    } catch (cause) {
      status.hidden = false;
      status.textContent = cause instanceof TypeError
        ? 'Hasil belum diketahui. Periksa data sebelum mencoba lagi.'
        : cause.message;
    }
  }

  async function bootstrap() {
    try {
      const profile = await api('/api/auth/me');
      role = profile.role;
      createButton.hidden = role !== 'ADMIN';
      if (role === 'ADMIN') csrfToken = (await api('/api/auth/csrf')).csrfToken;
      await load();
      title.focus();
    } catch (cause) {
      document.querySelector('#error-message').textContent = cause.message;
      setState('error');
    }
  }

  createButton.addEventListener('click', async () => {
    editingId = null;
    document.querySelector('#form-title').textContent = `Tambah ${config.title}`;
    await openBuiltForm(
      () => buildForm(),
      controller,
      createButton,
      status,
    );
  });
  cancelButton.addEventListener('click', controller.close);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) controller.close();
  });
  document.querySelector('#filters').addEventListener('submit', (event) => {
    event.preventDefault();
    page = 1;
    load();
  });
  document.querySelector('#retry-button').addEventListener('click', load);
  document.querySelector('#previous-page').addEventListener('click', () => { page -= 1; load(); });
  document.querySelector('#next-page').addEventListener('click', () => { page += 1; load(); });
  document.querySelector('#master-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (role !== 'ADMIN' || !controller.startCommit()) return;
    const save = document.querySelector('#save-button');
    save.disabled = true;
    const payload = formPayload(new FormData(event.currentTarget), config.fields, Boolean(editingId));
    try {
      await api(editingId ? `/api/${type}/${editingId}` : `/api/${type}`, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify(payload),
      });
      dialog.close();
      await load();
      status.hidden = false;
      status.textContent = 'Data berhasil disimpan.';
    } catch (cause) {
      const output = document.querySelector('#form-error');
      output.textContent = cause instanceof TypeError
        ? 'Hasil belum diketahui. Periksa data sebelum mencoba lagi.'
        : cause.message;
      output.hidden = false;
    } finally {
      save.disabled = false;
      controller.finishCommit();
    }
  });

  bootstrap();
}
