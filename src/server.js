import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pool } from './db/pool.js';
import { authenticate, sessionSecret } from './http/middleware/auth.js';
import { csrfTokenForSession, validCsrf, validOrigin } from './http/middleware/csrf.js';
import { createLoginLimiter } from './http/middleware/rate-limit.js';
import { revokeSession } from './repositories/sessions.js';
import { login } from './services/auth.js';

const host = process.env.HOST || '0.0.0.0';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const appOrigin = process.env.APP_ORIGIN;
const loginLimiter = createLoginLimiter();

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function failure(response, status, errorCode, message, details = {}, headers = {}) {
  json(response, status, { success: false, errorCode, message, details }, headers);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw Object.assign(new Error('Invalid JSON object.'), { status: 400 });
  }
  return value;
}

function sessionCookie(secret, maxAge) {
  return `session=${encodeURIComponent(secret)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function route(request, response) {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'GET' && path === '/health') {
    json(response, 200, { success: true });
    return;
  }

  if (request.method === 'POST' && path === '/api/auth/login') {
    if (!validOrigin(request, appOrigin)) {
      failure(response, 403, 'ORIGIN_INVALID', 'Origin is not allowed.');
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      failure(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
      return;
    }
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !['email', 'password'].includes(key))
        || typeof body.email !== 'string' || typeof body.password !== 'string') {
      failure(response, 400, 'VALIDATION_ERROR', 'Invalid login request.');
      return;
    }
    const lease = loginLimiter.acquire(request.socket.remoteAddress || 'unknown', body.email);
    if (!lease.allowed) {
      await pool.query(`
        INSERT INTO audit_logs (id, timestamp, action, module, reference, details)
        VALUES ($1, now(), 'LOGIN_RATE_LIMITED', 'AUTH', $2, $3::jsonb)
      `, [randomUUID(), body.email.trim().toLowerCase(), JSON.stringify({ ip: request.socket.remoteAddress || 'unknown' })]);
      failure(
        response,
        429,
        'RATE_LIMITED',
        'Too many login attempts.',
        { retryAfterSeconds: lease.retryAfterSeconds },
        { 'retry-after': String(lease.retryAfterSeconds) },
      );
      return;
    }
    const result = await login(pool, body.email, body.password);
    if (result.error === 'INVALID_CREDENTIALS') {
      loginLimiter.failure(lease);
      failure(response, 401, result.error, 'Invalid credentials.');
      return;
    }
    if (result.error === 'USER_INACTIVE') {
      loginLimiter.failure(lease);
      failure(response, 403, result.error, 'User is inactive.');
      return;
    }
    loginLimiter.success(lease);
    json(response, 200, { success: true, data: result.data, message: 'OK' }, {
      'set-cookie': sessionCookie(result.session.secret, result.session.maxAge),
    });
    return;
  }

  if (request.method === 'GET' && path === '/api/auth/me') {
    const user = await authenticate(pool, request);
    if (!user) {
      failure(response, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    json(response, 200, { success: true, data: user, message: 'OK' });
    return;
  }

  if (request.method === 'GET' && path === '/api/auth/csrf') {
    const secret = sessionSecret(request);
    const user = await authenticate(pool, request);
    if (!user) {
      failure(response, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    json(response, 200, {
      success: true,
      data: { csrfToken: csrfTokenForSession(secret) },
      message: 'OK',
    });
    return;
  }

  if (request.method === 'POST' && path === '/api/auth/logout') {
    const secret = sessionSecret(request);
    const user = await authenticate(pool, request);
    if (!user) {
      failure(response, 401, 'UNAUTHENTICATED', 'Authentication required.');
      return;
    }
    if (!validOrigin(request, appOrigin)) {
      failure(response, 403, 'ORIGIN_INVALID', 'Origin is not allowed.');
      return;
    }
    if (!await validCsrf(pool, secret, request.headers['x-csrf-token'])) {
      failure(response, 403, 'CSRF_INVALID', 'CSRF token is invalid.');
      return;
    }
    await revokeSession(pool, secret);
    json(response, 200, { success: true, data: {}, message: 'OK' }, {
      'set-cookie': sessionCookie('', 0),
    });
    return;
  }

  failure(response, 404, 'NOT_FOUND', 'Route not found.');
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    if (error.status) {
      failure(response, error.status, 'INVALID_REQUEST', error.message);
      return;
    }
    console.error('request_failed');
    if (!response.headersSent) failure(response, 500, 'INTERNAL_ERROR', 'Internal server error.');
    else response.destroy();
  });
});

server.listen(port, host);

function shutdown() {
  server.close(async (error) => {
    await pool.end();
    if (error) process.exitCode = 1;
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
