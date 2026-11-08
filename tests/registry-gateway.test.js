'use strict';

// Chạy: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createRegistryServer, Registry } = require('../services/registry/registry');
const { createGatewayServer } = require('../services/gateway/gateway');
const { RegistryClient } = require('../packages/registry-client');

const quiet = { log() {}, warn() {} };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function backend(name) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['idempotency-key'], body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name }));
    });
  });
  server.seen = seen;
  return server;
}

async function setup(t, backendNames, routes, gatewayOpts = {}) {
  const registry = new Registry({ logger: quiet });
  const registryServer = createRegistryServer({ registry, sweepIntervalMs: 50 });
  const registryUrl = `http://127.0.0.1:${await listen(registryServer)}`;

  const backends = {};
  for (const name of backendNames) {
    const server = backend(name);
    const port = await listen(server);
    const client = new RegistryClient({
      registryUrl, serviceName: 'inventory-service', instanceId: name, host: '127.0.0.1', port,
      handleSignals: false, logger: quiet,
    });
    await client.register();
    backends[name] = { server, client, port };
  }

  const gateway = createGatewayServer({
    registryUrl,
    routes: routes || [{ prefix: '/inventory', service: 'inventory-service' }],
    cacheTtlMs: 0,
    upstreamTimeoutMs: 1000,
    quarantineMs: 0,
    logger: quiet,
    ...gatewayOpts,
  });
  const gwUrl = `http://127.0.0.1:${await listen(gateway)}`;

  t.after(() => {
    gateway.close();
    registryServer.close();
    for (const b of Object.values(backends)) b.server.close();
  });
  return { registry, registryUrl, gwUrl, backends };
}

test('registry: register, lookup, heartbeat, deregister', async (t) => {
  const { registryUrl } = await setup(t, ['a', 'b']);
  let r = await (await fetch(`${registryUrl}/services/inventory-service`)).json();
  assert.deepStrictEqual(r.instances.map((i) => i.instanceId), ['a', 'b']);

  const hb = await fetch(`${registryUrl}/services/inventory-service/instances/a/heartbeat`, { method: 'PUT' });
  assert.strictEqual(hb.status, 200);
  const hb404 = await fetch(`${registryUrl}/services/inventory-service/instances/zzz/heartbeat`, { method: 'PUT' });
  assert.strictEqual(hb404.status, 404);

  const del = await fetch(`${registryUrl}/services/inventory-service/instances/a`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  r = await (await fetch(`${registryUrl}/services/inventory-service`)).json();
  assert.deepStrictEqual(r.instances.map((i) => i.instanceId), ['b']);
});

test('registry: instance expires after TTL without heartbeat', () => {
  let now = 0;
  const reg = new Registry({ now: () => now, logger: quiet });
  reg.register({ serviceName: 's', instanceId: 'x', host: 'h', port: 1, ttlSeconds: 2 });
  now = 1500;
  reg.heartbeat('s', 'x'); // gia hạn tới 3500
  now = 3000;
  assert.strictEqual(reg.lookup('s').length, 1);
  now = 3600;
  assert.strictEqual(reg.lookup('s').length, 0);
});

test('gateway: round-robin across instances', async (t) => {
  const { gwUrl } = await setup(t, ['a', 'b', 'c']);
  const served = [];
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${gwUrl}/inventory/stock/P1`);
    assert.strictEqual(res.status, 200);
    served.push(res.headers.get('x-served-by'));
  }
  assert.deepStrictEqual(served, ['a', 'b', 'c', 'a', 'b', 'c']);
});

test('gateway: new replica starts receiving traffic', async (t) => {
  const { gwUrl, registryUrl } = await setup(t, ['a']);
  const extra = backend('b');
  const port = await listen(extra);
  t.after(() => extra.close());
  await new RegistryClient({
    registryUrl, serviceName: 'inventory-service', instanceId: 'b', host: '127.0.0.1', port,
    handleSignals: false, logger: quiet,
  }).register();
  const served = new Set();
  for (let i = 0; i < 4; i++) served.add((await fetch(`${gwUrl}/inventory/x`)).headers.get('x-served-by'));
  assert.deepStrictEqual([...served].sort(), ['a', 'b']);
});

test('gateway: GET retries next instance when one is down', async (t) => {
  const { gwUrl, backends } = await setup(t, ['a', 'b']);
  await new Promise((r) => backends.a.server.close(r)); // a chết nhưng vẫn còn trong registry
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${gwUrl}/inventory/x`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-served-by'), 'b');
  }
});

test('gateway: POST without Idempotency-Key is not retried; with key it is retried and key forwarded', async (t) => {
  const { gwUrl, backends } = await setup(t, ['a', 'b']);
  await new Promise((r) => backends.a.server.close(r));

  // Lượt đầu round-robin rơi vào 'a' (đã chết).
  const noKey = await fetch(`${gwUrl}/inventory/reserve`, { method: 'POST', body: '{"q":1}' });
  assert.strictEqual(noKey.status, 502);
  assert.strictEqual((await noKey.json()).retried, false);

  await fetch(`${gwUrl}/inventory/x`); // đẩy round-robin quay lại 'a'
  const withKey = await fetch(`${gwUrl}/inventory/reserve`, {
    method: 'POST', body: '{"q":1}', headers: { 'Idempotency-Key': 'k-123', 'content-type': 'application/json' },
  });
  assert.strictEqual(withKey.status, 200);
  assert.strictEqual(withKey.headers.get('x-served-by'), 'b');
  assert.strictEqual(withKey.headers.get('x-gateway-attempts'), '2');
  const last = backends.b.server.seen.at(-1);
  assert.strictEqual(last.key, 'k-123');
  assert.strictEqual(last.body, '{"q":1}');
});

test('gateway: 404 for unknown route, 503 when service has no instance', async (t) => {
  const { gwUrl } = await setup(t, ['a'], [
    { prefix: '/inventory', service: 'inventory-service' },
    { prefix: '/payments', service: 'payment-service' },
  ]);
  assert.strictEqual((await fetch(`${gwUrl}/unknown`)).status, 404);
  assert.strictEqual((await fetch(`${gwUrl}/payments/1`)).status, 503);
});

test('gateway: failed instance is quarantined so later requests skip it', async (t) => {
  const { gwUrl, backends } = await setup(t, ['a', 'b'], undefined, { quarantineMs: 60000 });
  await new Promise((r) => backends.a.server.close(r));
  const first = await fetch(`${gwUrl}/inventory/x`);
  assert.strictEqual(first.headers.get('x-gateway-attempts'), '2');
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${gwUrl}/inventory/x`);
    assert.strictEqual(res.headers.get('x-served-by'), 'b');
    assert.strictEqual(res.headers.get('x-gateway-attempts'), '1');
  }
});
