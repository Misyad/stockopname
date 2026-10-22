import { authenticate, sessionSecret } from './middleware/auth.js';
import { validCsrf, validOrigin } from './middleware/csrf.js';
import { createMaster, deactivateMaster, listMasters, updateMaster } from '../services/master.js';
import { listStock, listTransactions, stockCard } from '../services/report.js';
import { dashboard } from '../services/dashboard.js';
import { exportReportCsv, listReport } from '../services/reports.js';
import { createOpeningStock, createStockIn, createStockOut } from '../services/transactions.js';
import { confirmImport, previewImport } from '../services/import.js';
import {
  approveOpname, createOpname, getOpname, listOpnames, rejectOpname,
  saveOpnameCounts, startOpname, submitOpname,
} from '../services/opname.js';

const transactionRoutes = Object.freeze({
  '/api/transactions/opening': createOpeningStock,
  '/api/transactions/in': createStockIn,
  '/api/transactions/out': createStockOut,
});

const routes = Object.freeze({
  categories: 'category',
  units: 'unit',
  'unit-aliases': 'unitAlias',
  warehouses: 'warehouse',
  suppliers: 'supplier',
  products: 'product',
  users: 'user',
});

function matchMasterPath(path) {
  const match = path.match(/^\/api\/([a-z-]+)(?:\/([0-9a-f-]+)(?:\/(status))?)?$/i);
  if (!match || !Object.hasOwn(routes, match[1])) return null;
  return { kind: routes[match[1]], id: match[2] || null, action: match[3] || null };
}

export async function handleTransactionRoute({
  request, response, pool, appOrigin, json, failure, readJson,
}) {
  const path = new URL(request.url, 'http://localhost').pathname;
  const createTransaction = transactionRoutes[path];
  if (!createTransaction || request.method !== 'POST') return false;
  const actor = await authenticate(pool, request);
  if (!actor) {
    failure(response, 401, 'UNAUTHENTICATED', 'Authentication required.');
    return true;
  }
  if (!validOrigin(request, appOrigin)) {
    failure(response, 403, 'ORIGIN_INVALID', 'Origin is not allowed.');
    return true;
  }
  const secret = sessionSecret(request);
  if (!await validCsrf(pool, secret, request.headers['x-csrf-token'])) {
    failure(response, 403, 'CSRF_INVALID', 'CSRF token is invalid.');
    return true;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    failure(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    return true;
  }
  const data = await createTransaction(pool, actor, await readJson(request));
  json(response, 201, { success: true, data, message: 'OK' });
  return true;
}

export async function handleImportRoute({
  request, response, pool, appOrigin, json, failure, readJson,
}) {
  const path = new URL(request.url, 'http://localhost').pathname;
  const confirmMatch = path.match(/^\/api\/imports\/([0-9a-f-]+)\/confirm$/i);
  const isPreview = path === '/api/imports/preview';
  if (request.method !== 'POST' || (!isPreview && !confirmMatch)) return false;
  const actor = await authenticate(pool, request);
  if (!actor) {
    failure(response, 401, 'UNAUTHENTICATED', 'Authentication required.');
    return true;
  }
  if (actor.role !== 'ADMIN') {
    failure(response, 403, 'FORBIDDEN', 'Insufficient permission.');
    return true;
  }
  if (!validOrigin(request, appOrigin)) {
    failure(response, 403, 'ORIGIN_INVALID', 'Origin is not allowed.');
    return true;
  }
  const secret = sessionSecret(request);
  if (!await validCsrf(pool, secret, request.headers['x-csrf-token'])) {
    failure(response, 403, 'CSRF_INVALID', 'CSRF token is invalid.');
    return true;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    failure(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    return true;
  }
  const body = await readJson(request, isPreview ? {
    maxBytes: 1_100_000,
    errorCode: 'IMPORT_FILE_TOO_LARGE',
    sizeMessage: 'CSV exceeds 1 MiB.',
  } : undefined);
  const data = isPreview
    ? await previewImport(pool, actor, body)
    : await confirmImport(pool, actor, confirmMatch[1], body);
  json(response, isPreview ? 201 : 200, { success: true, data, message: 'OK' });
  return true;
}

export async function handleOpnameRoute({
  request, response, pool, appOrigin, json, failure, readJson,
}) {
  const path = new URL(request.url, 'http://localhost').pathname;
  const itemMatch = path.match(/^\/api\/opnames\/([0-9a-f-]+)(?:\/(start|counts|submit|approve|reject))?$/i);
  const isCreate = request.method === 'POST' && path === '/api/opnames';
  const isList = request.method === 'GET' && path === '/api/opnames';
  const isDetail = request.method === 'GET' && itemMatch && !itemMatch[2];
  const isMutation = request.method === 'POST' && itemMatch && itemMatch[2];
  if (!isCreate && !isList && !isDetail && !isMutation) return false;
  const actor = await authenticate(pool, request);
  if (!actor) {
    failure(response, 401, 'UNAUTHENTICATED', 'Authentication required.');
    return true;
  }
  if (isList || isDetail) {
    const data = isList
      ? await listOpnames(pool, actor, Object.fromEntries(new URL(request.url, 'http://localhost').searchParams))
      : await getOpname(pool, actor, itemMatch[1]);
    json(response, 200, { success: true, data, message: 'OK' });
    return true;
  }
  if (!validOrigin(request, appOrigin)) {
    failure(response, 403, 'ORIGIN_INVALID', 'Origin is not allowed.');
    return true;
  }
  const secret = sessionSecret(request);
  if (!await validCsrf(pool, secret, request.headers['x-csrf-token'])) {
    failure(response, 403, 'CSRF_INVALID', 'CSRF token is invalid.');
    return true;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    failure(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    return true;
  }
  const body = await readJson(request);
  let data;
  if (isCreate) data = await createOpname(pool, actor, body);
  else if (itemMatch[2] === 'start') data = await startOpname(pool, actor, itemMatch[1]);
  else if (itemMatch[2] === 'counts') data = await saveOpnameCounts(pool, actor, itemMatch[1], body);
  else if (itemMatch[2] === 'submit') data = await submitOpname(pool, actor, itemMatch[1]);
  else if (itemMatch[2] === 'approve') data = await approveOpname(pool, actor, itemMatch[1], body);
  else data = await rejectOpname(pool, actor, itemMatch[1], body);
  json(response, isCreate ? 201 : 200, { success: true, data, message: 'OK' });
  return true;
}

export async function handleInventoryReadRoute({ request, response, pool, json, failure }) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url, 'http://localhost');
  const stockCardMatch = url.pathname.match(/^\/api\/stock-card\/([^/]+)$/);
  if (url.pathname !== '/api/stock' && url.pathname !== '/api/transactions' && !stockCardMatch) {
    return false;
  }
  const actor = await authenticate(pool, request);
  if (!actor) {
    failure(response, 401, 'UNAUTHENTICATED', 'Authentication required.');
    return true;
  }
  const options = Object.fromEntries(url.searchParams);
  let data;
  if (url.pathname === '/api/stock') data = await listStock(pool, actor, options);
  else if (url.pathname === '/api/transactions') data = await listTransactions(pool, actor, options);
  else data = await stockCard(pool, actor, stockCardMatch[1], options);
  json(response, 200, { success: true, data, message: 'OK' });
  return true;
}

export async function handleReportingRoute({ request, response, pool, json, failure }) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url, 'http://localhost');
  const reportMatch = url.pathname.match(/^\/api\/reports\/([A-Z_]+)(\/export)?$/i);
  if (url.pathname !== '/api/dashboard' && !reportMatch) return false;
  const actor = await authenticate(pool, request);
  if (!actor) {
    failure(response, 401, 'UNAUTHENTICATED', 'Authentication required.');
    return true;
  }
  const query = Object.fromEntries(url.searchParams);
  if (url.pathname === '/api/dashboard') {
    json(response, 200, { success: true, data: await dashboard(pool, actor), message: 'OK' });
  } else if (reportMatch[2]) {
    await exportReportCsv(pool, actor, reportMatch[1], query, response);
  } else {
    json(response, 200, {
      success: true,
      data: await listReport(pool, actor, reportMatch[1], query),
      message: 'OK',
    });
  }
  return true;
}

export async function handleMasterRoute({
  request,
  response,
  pool,
  appOrigin,
  json,
  failure,
  readJson,
}) {
  const url = new URL(request.url, 'http://localhost');
  const match = matchMasterPath(url.pathname);
  if (!match || !['GET', 'POST', 'PATCH'].includes(request.method)) return false;

  const actor = await authenticate(pool, request);
  if (!actor) {
    failure(response, 401, 'UNAUTHENTICATED', 'Authentication required.');
    return true;
  }

  if (request.method === 'GET') {
    if (match.id) return false;
    const data = await listMasters(pool, actor, match.kind, Object.fromEntries(url.searchParams));
    json(response, 200, { success: true, data, message: 'OK' });
    return true;
  }

  if (!validOrigin(request, appOrigin)) {
    failure(response, 403, 'ORIGIN_INVALID', 'Origin is not allowed.');
    return true;
  }
  const secret = sessionSecret(request);
  if (!await validCsrf(pool, secret, request.headers['x-csrf-token'])) {
    failure(response, 403, 'CSRF_INVALID', 'CSRF token is invalid.');
    return true;
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    failure(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    return true;
  }

  const body = await readJson(request);
  if (request.method === 'POST' && !match.id && !match.action) {
    const data = await createMaster(pool, actor, match.kind, body);
    json(response, 201, { success: true, data, message: 'OK' });
    return true;
  }
  const userStatus = match.kind === 'user' && match.id && match.action === 'status';
  const masterUpdate = match.kind !== 'user' && match.id && !match.action;
  if (request.method === 'PATCH' && userStatus) {
    if (Object.keys(body).length !== 1 || body.status !== 'INACTIVE') {
      failure(response, 400, 'VALIDATION_ERROR', 'Only user deactivation is allowed.');
      return true;
    }
    const data = await deactivateMaster(pool, actor, match.kind, match.id);
    json(response, 200, { success: true, data, message: 'OK' });
    return true;
  }
  if (request.method === 'PATCH' && masterUpdate) {
    if (Object.keys(body).length === 0) {
      failure(response, 400, 'VALIDATION_ERROR', 'At least one master field is required.');
      return true;
    }
    const deactivation = Object.keys(body).length === 1 && body.status === 'INACTIVE';
    const data = deactivation
      ? await deactivateMaster(pool, actor, match.kind, match.id)
      : await updateMaster(pool, actor, match.kind, match.id, body);
    json(response, 200, { success: true, data, message: 'OK' });
    return true;
  }
  return false;
}
