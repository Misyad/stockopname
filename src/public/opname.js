function cell(document, value) {
  const element = document.createElement('td');
  element.textContent = value ?? '';
  return element;
}

export function renderOpnameItems(document, body, role, items) {
  const privileged = role === 'ADMIN' || role === 'SUPERVISOR';
  const rows = items.map((item) => {
    const row = document.createElement('tr');
    row.append(
      cell(document, item.productName),
      cell(document, item.batchNumber),
      cell(document, item.unit),
      cell(document, item.physicalQuantity),
    );
    if (privileged) row.append(cell(document, item.systemQuantity), cell(document, item.difference));
    return row;
  });
  body.replaceChildren(...rows);
}

export function renderOpnameReview(document, body, items) {
  const rows = items.map((item) => {
    const row = document.createElement('tr');
    row.append(
      cell(document, item.productName),
      cell(document, item.systemQuantity),
      cell(document, item.physicalQuantity),
      cell(document, item.difference),
      cell(document, item.differenceValue),
      cell(document, item.reason),
    );
    return row;
  });
  body.replaceChildren(...rows);
}

export function approvalFailureMessage(errorCode) {
  if (errorCode === 'STOCK_MOVED_DURING_OPNAME' || errorCode === 'STOCK_CHANGED_AFTER_OPNAME') {
    return 'Stok berubah setelah snapshot. Buat recount atau stock opname baru; force approve tidak tersedia.';
  }
  return null;
}

function appendSummary(document, target, entries) {
  target.replaceChildren();
  for (const [label, value] of entries) {
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = value ?? '—';
    target.append(term, detail);
  }
}

if (typeof document !== 'undefined') {
  const detailId = location.pathname.match(/^\/opnames\/([0-9a-f-]+)$/i)?.[1];
  const status = document.querySelector('#screen-status');
  const errorState = document.querySelector('#error-state');
  const errorMessage = document.querySelector('#error-message');
  const listView = document.querySelector('#list-view');
  const detailView = document.querySelector('#detail-view');
  const backLink = document.querySelector('#back-link');
  let profile;
  let csrfToken;
  let page = 1;
  let hasNext = false;
  let current;
  let loading = false;

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const payload = await response.json();
    if (response.status === 401) {
      location.assign('/login');
      throw new Error('Sesi berakhir. Silakan masuk kembali.');
    }
    if (!response.ok) {
      const failure = new Error(payload.message || 'Permintaan gagal.');
      failure.errorCode = payload.errorCode;
      throw failure;
    }
    return payload.data;
  }

  async function mutate(path, body = {}) {
    return api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(body),
    });
  }

  function state(name, message = '') {
    status.hidden = name !== 'loading';
    status.textContent = message || 'Memuat data…';
    errorState.hidden = name !== 'error';
    listView.hidden = name !== 'list';
    detailView.hidden = name !== 'detail';
  }

  function failure(target, cause) {
    target.textContent = cause.message;
    target.hidden = false;
  }

  function listRow(item) {
    const row = document.createElement('tr');
    const number = cell(document, '');
    const link = document.createElement('a');
    link.href = `/opnames/${encodeURIComponent(item.id)}`;
    link.textContent = item.opnameNumber;
    number.append(link);
    row.append(
      number, cell(document, item.date), cell(document, item.warehouseCode),
      cell(document, item.status), cell(document, item.itemCount), cell(document, item.creatorName),
    );
    return row;
  }

  async function loadList() {
    if (loading) return;
    loading = true;
    state('loading');
    const params = new URLSearchParams(new FormData(document.querySelector('#filters')));
    for (const [key, value] of [...params]) if (!value) params.delete(key);
    params.set('page', String(page));
    params.set('limit', '25');
    try {
      const data = await api(`/api/opnames?${params}`);
      document.querySelector('#list-body').replaceChildren(...data.items.map(listRow));
      document.querySelector('#results').hidden = data.items.length === 0;
      document.querySelector('#empty-state').hidden = data.items.length !== 0;
      document.querySelector('#page-summary').textContent = `Halaman ${data.page} · ${data.total} data`;
      document.querySelector('#previous-page').disabled = data.page <= 1;
      document.querySelector('#next-page').disabled = !data.hasNext;
      hasNext = data.hasNext;
      state('list');
    } catch (cause) {
      errorMessage.textContent = cause.message;
      state('error');
    } finally {
      loading = false;
    }
  }

  function quantityInput(item, name, type = 'number') {
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    input.name = name;
    input.dataset.itemId = item.id;
    input.value = item[name] ?? '';
    if (type === 'number') {
      input.type = 'number';
      input.min = '0';
      input.step = 'any';
      input.required = true;
      input.setAttribute('aria-label', `Jumlah fisik ${item.productName}`);
    } else {
      input.maxLength = 2000;
      input.setAttribute('aria-label', `${name === 'reason' ? 'Alasan' : 'Catatan'} ${item.productName}`);
    }
    return input;
  }

  function countRows(items) {
    const privileged = profile.role === 'ADMIN' || profile.role === 'SUPERVISOR';
    const headers = ['Barang', 'Batch', 'Satuan', 'Fisik', 'Alasan', 'Catatan'];
    if (privileged) headers.splice(3, 0, 'Sistem');
    document.querySelector('#count-head').replaceChildren(...headers.map((value) => {
      const header = document.createElement('th');
      header.scope = 'col';
      header.textContent = value;
      return header;
    }));
    const rows = items.map((item) => {
      const row = document.createElement('tr');
      row.append(cell(document, item.productName), cell(document, item.batchNumber), cell(document, item.unit));
      if (privileged) row.append(cell(document, item.systemQuantity));
      for (const [name, type] of [['physicalQuantity', 'number'], ['reason', 'textarea'], ['notes', 'textarea']]) {
        const field = document.createElement('td');
        field.append(quantityInput(item, name, type));
        row.append(field);
      }
      return row;
    });
    document.querySelector('#count-body').replaceChildren(...rows);
  }

  function showDetail(data) {
    current = data;
    appendSummary(document, document.querySelector('#detail-summary'), [
      ['Nomor', data.opnameNumber], ['Tanggal', data.date], ['Status', data.status],
      ['Jumlah item', String(data.items.length)], ['Catatan', data.notes],
    ]);
    const rejection = document.querySelector('#rejection-state');
    rejection.hidden = !data.rejectionReason;
    rejection.textContent = data.rejectionReason ? `Ditolak: ${data.rejectionReason}` : '';
    const canCount = profile.role === 'SUPERVISOR' || data.createdBy === profile.userId;
    const start = document.querySelector('#start-button');
    start.hidden = !canCount || !['DRAFT', 'REJECTED'].includes(data.status);
    const countForm = document.querySelector('#count-form');
    countForm.hidden = !canCount || data.status !== 'COUNTING';
    if (!countForm.hidden) countRows(data.items);
    const review = document.querySelector('#review-view');
    const privileged = profile.role === 'ADMIN' || profile.role === 'SUPERVISOR';
    review.hidden = !privileged || !['SUBMITTED', 'APPROVED'].includes(data.status);
    if (!review.hidden) renderOpnameReview(document, document.querySelector('#review-body'), data.items);
    document.querySelector('#review-actions').hidden = !privileged || data.status !== 'SUBMITTED';
    state('detail');
  }

  async function loadDetail() {
    state('loading');
    try {
      showDetail(await api(`/api/opnames/${detailId}`));
    } catch (cause) {
      errorMessage.textContent = cause.message;
      state('error');
    }
  }

  async function action(name, body = {}) {
    const actionError = document.querySelector('#action-error');
    actionError.hidden = true;
    try {
      await mutate(`/api/opnames/${detailId}/${name}`, body);
      await loadDetail();
    } catch (cause) {
      cause.message = approvalFailureMessage(cause.errorCode) || cause.message;
      failure(actionError, cause);
    }
  }

  function confirmAction(name, message, body = {}) {
    if (window.confirm(message)) action(name, body);
  }

  document.querySelector('#opname-date').value = new Date().toISOString().slice(0, 10);
  document.querySelector('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const target = document.querySelector('#create-error');
    target.hidden = true;
    try {
      const data = await mutate('/api/opnames', Object.fromEntries(new FormData(event.currentTarget)));
      location.assign(`/opnames/${data.id}`);
    } catch (cause) { failure(target, cause); }
  });
  document.querySelector('#filters').addEventListener('submit', (event) => {
    event.preventDefault(); page = 1; loadList();
  });
  document.querySelector('#previous-page').addEventListener('click', () => { if (page > 1) { page -= 1; loadList(); } });
  document.querySelector('#next-page').addEventListener('click', () => { if (hasNext) { page += 1; loadList(); } });
  document.querySelector('#start-button').addEventListener('click', () => action('start'));
  document.querySelector('#count-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const items = current.items.map((item) => ({
      itemId: item.id,
      physicalQuantity: values.getAll('physicalQuantity')[current.items.indexOf(item)],
      reason: values.getAll('reason')[current.items.indexOf(item)] || undefined,
      notes: values.getAll('notes')[current.items.indexOf(item)] || undefined,
    }));
    try { await action('counts', { items }); } catch {}
  });
  document.querySelector('#submit-button').addEventListener('click', () => action('submit'));
  document.querySelector('#approve-button').addEventListener('click', () => confirmAction(
    'approve', 'Setujui penyesuaian stok ini? Tindakan tidak dapat dibatalkan.',
  ));
  document.querySelector('#show-reject-button').addEventListener('click', () => { document.querySelector('#reject-form').hidden = false; });
  document.querySelector('#cancel-reject').addEventListener('click', () => { document.querySelector('#reject-form').hidden = true; });
  document.querySelector('#reject-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get('reason');
    confirmAction('reject', 'Tolak opname ini untuk dihitung ulang?', { reason });
  });
  document.querySelector('#retry-button').addEventListener('click', () => detailId ? loadDetail() : loadList());

  (async () => {
    try {
      [profile, { csrfToken }] = await Promise.all([api('/api/auth/me'), api('/api/auth/csrf')]);
      backLink.hidden = !detailId;
      if (detailId) await loadDetail(); else await loadList();
      document.querySelector('#page-title').focus();
    } catch (cause) {
      errorMessage.textContent = cause.message;
      state('error');
    }
  })();
}
