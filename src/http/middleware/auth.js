import { resolveSession } from '../../repositories/sessions.js';

export function sessionSecret(request) {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(';')) {
    const [name, ...value] = pair.trim().split('=');
    if (name === 'session') {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function authenticate(pool, request) {
  return resolveSession(pool, sessionSecret(request));
}
