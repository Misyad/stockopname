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
