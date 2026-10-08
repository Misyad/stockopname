const WINDOW_MS = 15 * 60 * 1000;

export function createLoginLimiter({
  emailLimit = 5,
  ipLimit = 30,
  maxEntries = 10_000,
  windowMs = WINDOW_MS,
  now = Date.now,
} = {}) {
  const buckets = new Map();

  function bucket(key, timestamp) {
    const current = buckets.get(key);
    if (current && current.resetAt > timestamp) return current;
    if (current) buckets.delete(key);
    if (buckets.size >= maxEntries) {
      for (const [storedKey, stored] of buckets) {
        if (stored.resetAt <= timestamp) buckets.delete(storedKey);
      }
    }
    if (buckets.size >= maxEntries) return null;
    const created = { count: 0, resetAt: timestamp + windowMs };
    buckets.set(key, created);
    return created;
  }

  function acquire(ip, rawEmail) {
    const timestamp = now();
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    const emailBucket = bucket(`email:${email}`, timestamp);
    const ipBucket = bucket(`ip:${ip}`, timestamp);
    const retryAt = Math.max(emailBucket?.resetAt || timestamp + windowMs, ipBucket?.resetAt || timestamp + windowMs);
    return {
      allowed: Boolean(emailBucket && ipBucket
        && emailBucket.count < emailLimit && ipBucket.count < ipLimit),
      emailKey: `email:${email}`,
      ipKey: `ip:${ip}`,
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt - timestamp) / 1000)),
    };
  }

  function failure(lease) {
    for (const key of [lease.emailKey, lease.ipKey]) {
      const current = buckets.get(key);
      if (current) current.count += 1;
    }
  }

  function success(lease) {
    buckets.delete(lease.emailKey);
  }

  return {
    acquire,
    failure,
    success,
    get size() { return buckets.size; },
  };
}
