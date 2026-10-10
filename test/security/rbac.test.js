import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  CAPABILITIES,
  authorize,
  can,
  projectOpnameItem,
  requireCapability,
} from '../../src/http/middleware/rbac.js';

const admin = { userId: 'admin', role: 'ADMIN' };
const supervisor = { userId: 'supervisor', role: 'SUPERVISOR' };
const petugas = { userId: 'petugas-1', role: 'PETUGAS' };

function denied(user, capability, resource) {
  return !can(user, capability, resource);
}

test('RBAC-001 PETUGAS cannot approve opname', () => {
  assert.ok(denied(petugas, CAPABILITIES.OPNAME_APPROVE));
});

test('RBAC-002 PETUGAS cannot reject opname', () => {
  assert.ok(denied(petugas, CAPABILITIES.OPNAME_REJECT));
});

test('RBAC-003 PETUGAS cannot create opening stock', () => {
  assert.ok(denied(petugas, CAPABILITIES.OPENING_STOCK));
});

test('RBAC-004 PETUGAS cannot confirm import', () => {
  assert.ok(denied(petugas, CAPABILITIES.IMPORT_CONFIRM));
});

test('RBAC-005 PETUGAS cannot run privileged mutations', () => {
  for (const capability of [
    CAPABILITIES.BACKUP,
    CAPABILITIES.REBUILD,
    CAPABILITIES.USER_MUTATE,
    CAPABILITIES.MASTER_MUTATE,
  ]) assert.ok(denied(petugas, capability));
});

test('RBAC-006 SUPERVISOR cannot mutate users or master data', () => {
  assert.ok(denied(supervisor, CAPABILITIES.USER_MUTATE));
  assert.ok(denied(supervisor, CAPABILITIES.MASTER_MUTATE));
});

test('RBAC-007 SUPERVISOR cannot import, backup, or rebuild', () => {
  assert.ok(denied(supervisor, CAPABILITIES.IMPORT_CONFIRM));
  assert.ok(denied(supervisor, CAPABILITIES.BACKUP));
  assert.ok(denied(supervisor, CAPABILITIES.REBUILD));
});

test('RBAC-008 ADMIN/PETUGAS can mutate only own opname', () => {
  for (const user of [admin, petugas]) {
    for (const capability of [CAPABILITIES.OPNAME_COUNT, CAPABILITIES.OPNAME_SUBMIT]) {
      assert.equal(can(user, capability, { created_by: user.userId }), true);
      assert.equal(can(user, capability, { created_by: 'another-user' }), false);
      assert.equal(can(user, capability, { createdBy: user.userId }), false);
    }
  }
});

test('RBAC-009 current role is evaluated on every authorization', () => {
  const current = { ...admin };
  assert.equal(can(current, CAPABILITIES.MASTER_MUTATE), true);
  current.role = 'PETUGAS';
  assert.equal(can(current, CAPABILITIES.MASTER_MUTATE), false);
});

test('RBAC-010 crafted direct HTTP request receives same 403 denial', async () => {
  const server = createServer((_request, response) => {
    if (!requireCapability(response, petugas, CAPABILITIES.OPNAME_APPROVE)) return;
    response.writeHead(204).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/crafted/opname/approve`, { method: 'POST' });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).errorCode, 'FORBIDDEN');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('RBAC-011 SUPERVISOR can create, count, and submit any opname', () => {
  assert.equal(can(supervisor, CAPABILITIES.OPNAME_CREATE), true);
  assert.equal(can(supervisor, CAPABILITIES.OPNAME_COUNT, { created_by: 'any-user' }), true);
  assert.equal(can(supervisor, CAPABILITIES.OPNAME_SUBMIT, { created_by: 'any-user' }), true);
});

test('RBAC-012 SUPERVISOR can approve opname they counted', () => {
  assert.equal(can(supervisor, CAPABILITIES.OPNAME_APPROVE, { created_by: supervisor.userId }), true);
});

test('warehouse region is enforced outside role-only policy', () => {
  assert.equal(can(petugas, CAPABILITIES.STOCK_READ), true);
  assert.equal(can(petugas, CAPABILITIES.STOCK_MOVE), true);
  assert.equal(Object.hasOwn(petugas, 'regionId'), false);
});

test('blind PETUGAS projection omits protected quantities', () => {
  const item = {
    id: 'item-1',
    system_quantity: '10',
    physical_quantity: '9',
    difference: '-1',
    difference_value: '-5000',
    unit: 'kg',
  };
  assert.deepEqual(projectOpnameItem(petugas, item), {
    id: 'item-1', physical_quantity: '9', unit: 'kg',
  });
  assert.deepEqual(projectOpnameItem(supervisor, item), item);
  assert.deepEqual(projectOpnameItem(null, item), {
    id: 'item-1', physical_quantity: '9', unit: 'kg',
  });
  assert.deepEqual(projectOpnameItem({ userId: 'x', role: 'UNKNOWN' }, item), {
    id: 'item-1', physical_quantity: '9', unit: 'kg',
  });
});

test('anonymous, unknown role, unknown capability, and audit mutation fail closed', () => {
  assert.equal(can(null, CAPABILITIES.STOCK_READ), false);
  assert.equal(can({ userId: 'x', role: 'UNKNOWN' }, CAPABILITIES.STOCK_READ), false);
  assert.equal(can(admin, 'UNKNOWN_CAPABILITY'), false);
  assert.equal(can(admin, CAPABILITIES.AUDIT_MUTATE), false);
});

test('service authorization throws typed denial before business mutation', () => {
  assert.throws(
    () => authorize(petugas, CAPABILITIES.MASTER_MUTATE),
    (error) => error.status === 403 && error.errorCode === 'FORBIDDEN',
  );
  assert.throws(
    () => authorize(null, CAPABILITIES.STOCK_READ),
    (error) => error.status === 401 && error.errorCode === 'UNAUTHENTICATED',
  );
  assert.equal(authorize(admin, CAPABILITIES.MASTER_MUTATE), admin);
});

test('route guard distinguishes anonymous 401 from wrong-role 403', () => {
  const writes = [];
  const response = {
    writeHead(status, headers) { writes.push({ status, headers }); },
    end(body) { writes[0].body = JSON.parse(body); },
  };
  assert.equal(requireCapability(response, null, CAPABILITIES.STOCK_READ), false);
  assert.equal(writes[0].status, 401);
  assert.equal(writes[0].body.errorCode, 'UNAUTHENTICATED');
});
