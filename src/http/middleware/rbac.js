export const CAPABILITIES = Object.freeze({
  USER_MUTATE: 'USER_MUTATE',
  MASTER_READ: 'MASTER_READ',
  MASTER_MUTATE: 'MASTER_MUTATE',
  DASHBOARD_READ: 'DASHBOARD_READ',
  STOCK_READ: 'STOCK_READ',
  STOCK_MOVE: 'STOCK_MOVE',
  OPENING_STOCK: 'OPENING_STOCK',
  OPNAME_CREATE: 'OPNAME_CREATE',
  OPNAME_COUNT: 'OPNAME_COUNT',
  OPNAME_SUBMIT: 'OPNAME_SUBMIT',
  OPNAME_APPROVE: 'OPNAME_APPROVE',
  OPNAME_REJECT: 'OPNAME_REJECT',
  REPORT_READ: 'REPORT_READ',
  IMPORT_CONFIRM: 'IMPORT_CONFIRM',
  BACKUP: 'BACKUP',
  HEALTH_READ: 'HEALTH_READ',
  REBUILD: 'REBUILD',
  AUDIT_MUTATE: 'AUDIT_MUTATE',
});

const policies = Object.freeze({
  ADMIN: new Set([
    CAPABILITIES.USER_MUTATE,
    CAPABILITIES.MASTER_READ,
    CAPABILITIES.MASTER_MUTATE,
    CAPABILITIES.DASHBOARD_READ,
    CAPABILITIES.STOCK_READ,
    CAPABILITIES.STOCK_MOVE,
    CAPABILITIES.OPENING_STOCK,
    CAPABILITIES.OPNAME_CREATE,
    CAPABILITIES.OPNAME_COUNT,
    CAPABILITIES.OPNAME_SUBMIT,
    CAPABILITIES.OPNAME_APPROVE,
    CAPABILITIES.OPNAME_REJECT,
    CAPABILITIES.REPORT_READ,
    CAPABILITIES.IMPORT_CONFIRM,
    CAPABILITIES.BACKUP,
    CAPABILITIES.HEALTH_READ,
    CAPABILITIES.REBUILD,
  ]),
  SUPERVISOR: new Set([
    CAPABILITIES.MASTER_READ,
    CAPABILITIES.DASHBOARD_READ,
    CAPABILITIES.STOCK_READ,
    CAPABILITIES.STOCK_MOVE,
    CAPABILITIES.OPNAME_CREATE,
    CAPABILITIES.OPNAME_COUNT,
    CAPABILITIES.OPNAME_SUBMIT,
    CAPABILITIES.OPNAME_APPROVE,
    CAPABILITIES.OPNAME_REJECT,
    CAPABILITIES.REPORT_READ,
    CAPABILITIES.HEALTH_READ,
  ]),
  PETUGAS: new Set([
    CAPABILITIES.MASTER_READ,
    CAPABILITIES.DASHBOARD_READ,
    CAPABILITIES.STOCK_READ,
    CAPABILITIES.STOCK_MOVE,
    CAPABILITIES.OPNAME_CREATE,
    CAPABILITIES.OPNAME_COUNT,
    CAPABILITIES.OPNAME_SUBMIT,
    CAPABILITIES.REPORT_READ,
  ]),
});

export function can(user, capability, resource) {
  if (!user || !Object.hasOwn(policies, user.role)) return false;
  if (!Object.values(CAPABILITIES).includes(capability)) return false;
  if (!policies[user.role].has(capability)) return false;
  if (
    (capability === CAPABILITIES.OPNAME_COUNT || capability === CAPABILITIES.OPNAME_SUBMIT)
    && user.role !== 'SUPERVISOR'
  ) {
    return Boolean(resource && resource.created_by === user.userId);
  }
  return true;
}

function denial(user) {
  return Object.assign(
    new Error(user ? 'Insufficient permission.' : 'Authentication required.'),
    {
      status: user ? 403 : 401,
      errorCode: user ? 'FORBIDDEN' : 'UNAUTHENTICATED',
    },
  );
}

export function authorize(user, capability, resource) {
  if (!can(user, capability, resource)) throw denial(user);
  return user;
}

export function requireCapability(response, user, capability, resource) {
  try {
    authorize(user, capability, resource);
    return true;
  } catch (error) {
    response.writeHead(error.status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      success: false,
      errorCode: error.errorCode,
      message: error.message,
      details: {},
    }));
    return false;
  }
}

export function projectOpnameItem(user, item) {
  if (user?.role === 'ADMIN' || user?.role === 'SUPERVISOR') return item;
  const projected = { ...item };
  for (const field of [
    'system_quantity',
    'systemQuantity',
    'difference',
    'difference_value',
    'differenceValue',
  ]) delete projected[field];
  return projected;
}
