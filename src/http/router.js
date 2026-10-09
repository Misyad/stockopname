import { authenticate, sessionSecret } from './middleware/auth.js';
import { validCsrf, validOrigin } from './middleware/csrf.js';
import { createMaster, deactivateMaster, listMasters, updateMaster } from '../services/master.js';

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
