'use strict';

/**
 * Mock backend dùng để demo Registry + Gateway khi chưa có module của người 2/3.
 * Cùng một chương trình, đổi SERVICE_NAME để đóng vai inventory-service, pricing-service...
 * Khi khởi động tự đăng ký vào Registry, gửi heartbeat định kỳ, hủy đăng ký khi tắt.
 *
 * Mọi request trả về JSON cho biết bản sao nào đã xử lý -> thấy rõ round-robin.
 *   GET  /__fail   : bật chế độ "chết giả" (đóng kết nối mọi request) để demo retry
 *   GET  /__recover: tắt chế độ trên
 */

const http = require('http');
const os = require('os');
const { RegistryClient } = require('../../packages/registry-client');

const SERVICE_NAME = process.env.SERVICE_NAME || 'inventory-service';
const PORT = Number(process.env.PORT || 3000);
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:4000';
const INSTANCE_ID = process.env.INSTANCE_ID || `${SERVICE_NAME}-${os.hostname()}`;

let failing = false;
let handled = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/__fail') { failing = true; return res.end('failing=true\n'); }
  if (req.url === '/__recover') { failing = false; return res.end('failing=false\n'); }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', instanceId: INSTANCE_ID }));
  }
  if (failing) return req.socket.destroy();

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    handled += 1;
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
    const out = JSON.stringify({
      service: SERVICE_NAME,
      instanceId: INSTANCE_ID,
      handledByThisInstance: handled,
      method: req.method,
      path: req.url,
      idempotencyKey: req.headers['idempotency-key'] || null,
      requestId: req.headers['x-request-id'] || null,
      body,
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(out);
  });
});

server.listen(PORT, async () => {
  console.log(`[${INSTANCE_ID}] listening on :${PORT}`);
  const client = new RegistryClient({
    registryUrl: REGISTRY_URL,
    serviceName: SERVICE_NAME,
    instanceId: INSTANCE_ID,
    port: PORT,
    ttlSeconds: Number(process.env.REGISTRY_TTL_SECONDS || 10),
    metadata: { kind: 'mock' },
  });
  await client.start();
});
