const MAX_BYTES = 1024 * 1024;

export async function sha256Text(content) {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cell(document, value) {
  const element = document.createElement('td');
  element.textContent = value ?? '—';
  return element;
}

export function renderPreview(document, body, rows) {
  body.replaceChildren(...rows.map((row) => {
    const values = Object.entries(row)
      .filter(([key]) => !['rowNumber', 'status', 'errors'].includes(key))
      .map(([key, value]) => `${key}: ${value}`)
      .join(' · ');
    const problems = row.errors.map((error) => `${error.code}: ${error.message}`).join(' ');
    const element = document.createElement('tr');
    element.append(
      cell(document, row.rowNumber),
      cell(document, values),
      cell(document, row.status),
      cell(document, problems),
    );
    return element;
  }));
}

if (typeof document !== 'undefined') {
  const form = document.querySelector('#import-form');
  const status = document.querySelector('#preview-status');
  const errors = document.querySelector('#preview-errors');
  const results = document.querySelector('#preview-results');
  const button = document.querySelector('#preview-button');
  const confirmButton = document.querySelector('#confirm-button');
  let csrfToken;
  let preview;

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

  async function bootstrap() {
    try {
      const profile = await api('/api/auth/me');
      if (profile.role !== 'ADMIN') throw new Error('Akses import hanya untuk ADMIN.');
      csrfToken = (await api('/api/auth/csrf')).csrfToken;
      document.querySelector('#page-title').focus();
    } catch (cause) {
      form.hidden = true;
      errors.textContent = cause.message;
      errors.hidden = false;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = document.querySelector('#import-file').files[0];
    if (!file) return;
    errors.hidden = true;
    results.hidden = true;
    confirmButton.hidden = true;
    preview = undefined;
    if (file.size > MAX_BYTES) {
      errors.textContent = 'CSV melebihi 1 MiB.';
      errors.hidden = false;
      return;
    }
    button.disabled = true;
    status.textContent = 'Memvalidasi CSV…';
    try {
      const content = await file.text();
      const data = await api('/api/imports/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          type: document.querySelector('#import-type').value,
          fileName: file.name,
          fileHash: await sha256Text(content),
          content,
        }),
      });
      preview = { ...data, type: document.querySelector('#import-type').value };
      renderPreview(document, document.querySelector('#preview-body'), data.rows);
      document.querySelector('#preview-summary').textContent = [
        `${data.rowCount} baris`, `${data.readyCount} siap`,
        `${data.reviewCount} review`, `${data.rejectedCount} ditolak`,
      ].join(' · ');
      results.hidden = false;
      confirmButton.hidden = !(preview.type === 'STOCKIN' && preview.status === 'READY');
      status.textContent = `Preview ${data.status}. Tidak ada perubahan stok.`;
    } catch (cause) {
      errors.textContent = cause instanceof TypeError
        ? 'Hasil belum diketahui. Periksa koneksi dan data staging sebelum mencoba lagi.'
        : cause.message;
      errors.hidden = false;
      status.textContent = '';
    } finally {
      button.disabled = false;
    }
  });

  confirmButton.addEventListener('click', async () => {
    if (!preview || preview.type !== 'STOCKIN' || preview.status !== 'READY') return;
    if (!window.confirm('Konfirmasi import akan menambah stok. Lanjutkan?')) return;
    confirmButton.disabled = true;
    errors.hidden = true;
    status.textContent = 'Mengimpor stok…';
    try {
      const data = await api(`/api/imports/${preview.batchId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          previewVersion: preview.previewVersion,
          idempotencyKey: `import:${preview.batchId}:${preview.previewVersion}`,
        }),
      });
      preview = { ...preview, status: data.status };
      confirmButton.hidden = true;
      status.textContent = `${data.importedCount} baris berhasil diimpor.`;
    } catch (cause) {
      errors.textContent = cause instanceof TypeError
        ? 'Hasil belum diketahui. Periksa stok lalu coba lagi; permintaan memakai kunci yang sama.'
        : cause.message;
      errors.hidden = false;
      status.textContent = '';
    } finally {
      confirmButton.disabled = false;
    }
  });

  bootstrap();
}
