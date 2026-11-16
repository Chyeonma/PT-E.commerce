'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { FileStore } = require('../packages/file-store');
const { PricingStore, createPricingHandler } = require('../services/pricing/pricing');
const { InventoryStore, createInventoryHandler } = require('../services/inventory/inventory');

const quiet = { log() {}, warn() {}, error() {} };

function makeTempFile(t, filename = 'state.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ecom-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, filename);
}

/** Gọi trực tiếp HTTP handler (req, res) không cần mở TCP socket để chạy nhanh trong mọi môi trường. */
function invokeHandler(handler, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = Readable.from(raw ? [Buffer.from(raw)] : []);
    req.method = method;
    req.url = url;
    req.headers = {};
    for (const [k, v] of Object.entries(headers)) req.headers[k.toLowerCase()] = v;

    let statusCode = 200;
    const resHeaders = {};
    const chunks = [];
    const res = {
      writeHead(code, hdrs = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(hdrs)) resHeaders[k.toLowerCase()] = v;
      },
      end(data) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: statusCode, headers: resHeaders, body: json, text });
      },
    };

    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('file-store: concurrent transactions across instances preserve all updates atomically', async (t) => {
  const filePath = makeTempFile(t, 'counter.json');
  const storeA = new FileStore({ filePath, initialData: { count: 0 } });
  const storeB = new FileStore({ filePath, initialData: { count: 0 } });

  await Promise.all([
    ...Array.from({ length: 10 }, () =>
      storeA.transact((state) => {
        state.count += 1;
        return state.count;
      })
    ),
    ...Array.from({ length: 10 }, () =>
      storeB.transact((state) => {
        state.count += 1;
        return state.count;
      })
    ),
  ]);

  const finalState = await storeA.read();
  assert.strictEqual(finalState.count, 20);
});

test('pricing: GetPrice, list prices, and update price across stateless replicas', async (t) => {
  const filePath = makeTempFile(t, 'pricing.json');
  const replica1 = new PricingStore({
    filePath,
    seedProducts: {
      P1: { productId: 'P1', name: 'Mechanical Keyboard', unitPrice: 1500000, currency: 'VND' },
      P2: { productId: 'P2', name: 'Wireless Mouse', unitPrice: 800000, currency: 'VND' },
    },
  });
  const replica2 = new PricingStore({ filePath });

  const handler1 = createPricingHandler({ store: replica1, instanceId: 'pricing-1', logger: quiet });
  const handler2 = createPricingHandler({ store: replica2, instanceId: 'pricing-2', logger: quiet });

  // 1. Lấy giá P1 với số lượng 3 ở bản sao 1
  const res1 = await invokeHandler(handler1, { method: 'GET', url: '/pricing/prices/P1?quantity=3' });
  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res1.body.productId, 'P1');
  assert.strictEqual(res1.body.unitPrice, 1500000);
  assert.strictEqual(res1.body.quantity, 3);
  assert.strictEqual(res1.body.totalPrice, 4500000);
  assert.strictEqual(res1.body.instanceId, 'pricing-1');

  // 2. Cập nhật giá P1 ở bản sao 1, đọc lại từ bản sao 2 thấy ngay giá mới
  const updateRes = await invokeHandler(handler1, {
    method: 'PUT',
    url: '/pricing/prices/P1',
    body: { unitPrice: 1200000, name: 'Mechanical Keyboard Pro' },
  });
  assert.strictEqual(updateRes.status, 200);

  const res2 = await invokeHandler(handler2, { method: 'GET', url: '/pricing/prices/P1?quantity=2' });
  assert.strictEqual(res2.status, 200);
  assert.strictEqual(res2.body.unitPrice, 1200000);
  assert.strictEqual(res2.body.totalPrice, 2400000);
  assert.strictEqual(res2.body.instanceId, 'pricing-2');

  // 3. Sản phẩm không tồn tại -> 404
  const notFound = await invokeHandler(handler2, { method: 'GET', url: '/pricing/prices/UNKNOWN' });
  assert.strictEqual(notFound.status, 404);
  assert.strictEqual(notFound.body.error, 'product_not_found');
});

test('inventory: ReserveStock, ConfirmReservation, ReleaseReservation across replicas', async (t) => {
  const filePath = makeTempFile(t, 'inventory.json');
  const now = 1_000_000;
  const replica1 = new InventoryStore({
    filePath,
    now: () => now,
    seedStock: { P1: { productId: 'P1', name: 'Keyboard', totalStock: 10 } },
  });
  const replica2 = new InventoryStore({ filePath, now: () => now });

  const h1 = createInventoryHandler({ store: replica1, instanceId: 'inv-1', logger: quiet });
  const h2 = createInventoryHandler({ store: replica2, instanceId: 'inv-2', logger: quiet });

  // 1. Giữ 4 sản phẩm P1 qua bản sao 1
  const rsv = await invokeHandler(h1, {
    method: 'POST',
    url: '/inventory/reserve',
    headers: { 'idempotency-key': 'ord-1-rsv' },
    body: { orderId: 'ORD-1', productId: 'P1', quantity: 4, ttlSeconds: 30 },
  });
  assert.strictEqual(rsv.status, 201);
  assert.strictEqual(rsv.body.status, 'RESERVED');
  assert.strictEqual(rsv.body.quantity, 4);
  const reservationId = rsv.body.reservationId;

  // 2. Kiểm tra tồn kho từ bản sao 2: total=10, reserved=4, available=6
  const stockMid = await invokeHandler(h2, { method: 'GET', url: '/inventory/stock/P1' });
  assert.strictEqual(stockMid.status, 200);
  assert.strictEqual(stockMid.body.totalStock, 10);
  assert.strictEqual(stockMid.body.reservedStock, 4);
  assert.strictEqual(stockMid.body.availableStock, 6);
  assert.strictEqual(stockMid.body.instanceId, 'inv-2');

  // 3. Gửi lặp lại cùng Idempotency-Key tới bản sao 2 -> không trừ thêm hàng, trả lại cùng reservationId
  const retryRsv = await invokeHandler(h2, {
    method: 'POST',
    url: '/inventory/reserve',
    headers: { 'idempotency-key': 'ord-1-rsv' },
    body: { orderId: 'ORD-1', productId: 'P1', quantity: 4, ttlSeconds: 30 },
  });
  assert.strictEqual(retryRsv.status, 200);
  assert.strictEqual(retryRsv.body.reservationId, reservationId);

  // 4. Xác nhận giữ hàng ở bản sao 2 -> totalStock giảm còn 6, soldStock = 4, reservedStock = 0
  const confirmed = await invokeHandler(h2, {
    method: 'POST',
    url: `/inventory/reservations/${reservationId}/confirm`,
  });
  assert.strictEqual(confirmed.status, 200);
  assert.strictEqual(confirmed.body.status, 'CONFIRMED');

  const stockAfterConfirm = await invokeHandler(h1, { method: 'GET', url: '/inventory/stock/P1' });
  assert.strictEqual(stockAfterConfirm.body.totalStock, 6);
  assert.strictEqual(stockAfterConfirm.body.reservedStock, 0);
  assert.strictEqual(stockAfterConfirm.body.availableStock, 6);
  assert.strictEqual(stockAfterConfirm.body.soldStock, 4);

  // 5. Tạo giữ hàng thứ 2 rồi hủy (ReleaseReservation) -> availableStock phục hồi ngay
  const rsv2 = await invokeHandler(h1, {
    method: 'POST',
    url: '/inventory/reserve',
    body: { orderId: 'ORD-2', productId: 'P1', quantity: 5, ttlSeconds: 30 },
  });
  assert.strictEqual(rsv2.status, 201);

  const released = await invokeHandler(h2, {
    method: 'POST',
    url: `/inventory/reservations/${rsv2.body.reservationId}/release`,
  });
  assert.strictEqual(released.status, 200);
  assert.strictEqual(released.body.status, 'RELEASED');

  const stockAfterRelease = await invokeHandler(h1, { method: 'GET', url: '/inventory/stock/P1' });
  assert.strictEqual(stockAfterRelease.body.availableStock, 6);
  assert.strictEqual(stockAfterRelease.body.reservedStock, 0);
});

test('inventory (minh chứng 1): concurrent requests for the last item across replicas only allow one winner', async (t) => {
  const filePath = makeTempFile(t, 'last-item.json');
  const replica1 = new InventoryStore({
    filePath,
    seedStock: { P_LAST: { productId: 'P_LAST', name: 'Limited GPU', totalStock: 1 } },
  });
  const replica2 = new InventoryStore({ filePath });

  const h1 = createInventoryHandler({ store: replica1, instanceId: 'inv-1', logger: quiet });
  const h2 = createInventoryHandler({ store: replica2, instanceId: 'inv-2', logger: quiet });

  // 2 request đồng thời vào 2 bản sao cùng tranh mua 1 sản phẩm cuối cùng
  const [resA, resB] = await Promise.all([
    invokeHandler(h1, {
      method: 'POST',
      url: '/inventory/reserve',
      body: { orderId: 'ORD-A', productId: 'P_LAST', quantity: 1, ttlSeconds: 30 },
    }),
    invokeHandler(h2, {
      method: 'POST',
      url: '/inventory/reserve',
      body: { orderId: 'ORD-B', productId: 'P_LAST', quantity: 1, ttlSeconds: 30 },
    }),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepStrictEqual(statuses, [201, 409]);

  const loser = resA.status === 409 ? resA : resB;
  assert.strictEqual(loser.body.error, 'insufficient_stock');

  const stock = await invokeHandler(h1, { method: 'GET', url: '/inventory/stock/P_LAST' });
  assert.strictEqual(stock.body.totalStock, 1);
  assert.strictEqual(stock.body.reservedStock, 1);
  assert.strictEqual(stock.body.availableStock, 0);
});

test('inventory (minh chứng 2): soft-state reservation expires after TTL and releases stock automatically', async (t) => {
  const filePath = makeTempFile(t, 'ttl-inventory.json');
  let now = 10_000;
  const replica1 = new InventoryStore({
    filePath,
    now: () => now,
    seedStock: { P1: { productId: 'P1', name: 'SSD 1TB', totalStock: 1 } },
  });
  const replica2 = new InventoryStore({ filePath, now: () => now });

  const h1 = createInventoryHandler({ store: replica1, instanceId: 'inv-1', logger: quiet });
  const h2 = createInventoryHandler({ store: replica2, instanceId: 'inv-2', logger: quiet });

  // 1. Giữ món hàng duy nhất với TTL = 5 giây (hết hạn lúc 15_000)
  const rsv1 = await invokeHandler(h1, {
    method: 'POST',
    url: '/inventory/reserve',
    body: { orderId: 'ORD-SLOW', productId: 'P1', quantity: 1, ttlSeconds: 5 },
  });
  assert.strictEqual(rsv1.status, 201);

  // 2. Tại t = 12_000 (chưa hết hạn), đơn khác hỏi mua sẽ bị từ chối (409)
  now = 12_000;
  const blocked = await invokeHandler(h2, {
    method: 'POST',
    url: '/inventory/reserve',
    body: { orderId: 'ORD-2', productId: 'P1', quantity: 1, ttlSeconds: 5 },
  });
  assert.strictEqual(blocked.status, 409);

  // 3. Tại t = 15_500 (đã quá TTL), lượng hàng tự động được giải phóng -> kiểm tra tồn kho available = 1
  now = 15_500;
  const stockAfterExpiry = await invokeHandler(h2, { method: 'GET', url: '/inventory/stock/P1' });
  assert.strictEqual(stockAfterExpiry.body.availableStock, 1);
  assert.strictEqual(stockAfterExpiry.body.reservedStock, 0);

  // 4. Đơn cũ cố tình confirm sau khi đã hết TTL -> bị từ chối 409 reservation_expired
  const lateConfirm = await invokeHandler(h1, {
    method: 'POST',
    url: `/inventory/reservations/${rsv1.body.reservationId}/confirm`,
  });
  assert.strictEqual(lateConfirm.status, 409);
  assert.strictEqual(lateConfirm.body.error, 'reservation_expired');

  // 5. Đơn mới giữ hàng thành công món hàng vừa được giải phóng
  const rsv2 = await invokeHandler(h2, {
    method: 'POST',
    url: '/inventory/reserve',
    body: { orderId: 'ORD-FAST', productId: 'P1', quantity: 1, ttlSeconds: 10 },
  });
  assert.strictEqual(rsv2.status, 201);
});

test('inventory: idempotent confirm/release and invalid state transition guards', async (t) => {
  const filePath = makeTempFile(t, 'guards-inventory.json');
  const store = new InventoryStore({
    filePath,
    seedStock: { P1: { productId: 'P1', name: 'Monitor', totalStock: 5 } },
  });
  const handler = createInventoryHandler({ store, instanceId: 'inv-1', logger: quiet });

  const rsv = await invokeHandler(handler, {
    method: 'POST',
    url: '/inventory/reserve',
    body: { orderId: 'ORD-10', productId: 'P1', quantity: 2, ttlSeconds: 30 },
  });
  const id = rsv.body.reservationId;

  // Confirm lần 1 -> 200, replayed = false
  const c1 = await invokeHandler(handler, { method: 'POST', url: `/inventory/reservations/${id}/confirm` });
  assert.strictEqual(c1.status, 200);
  assert.strictEqual(c1.body.replayed, false);
  assert.strictEqual(c1.body.stock.totalStock, 3);

  // Confirm lần 2 (retry) -> 200, replayed = true, không trừ kho lần 2
  const c2 = await invokeHandler(handler, { method: 'POST', url: `/inventory/reservations/${id}/confirm` });
  assert.strictEqual(c2.status, 200);
  assert.strictEqual(c2.body.replayed, true);
  assert.strictEqual(c2.body.stock.totalStock, 3);

  // Không thể release một giữ hàng đã CONFIRMED -> 409 reservation_already_confirmed
  const badRelease = await invokeHandler(handler, { method: 'POST', url: `/inventory/reservations/${id}/release` });
  assert.strictEqual(badRelease.status, 409);
  assert.strictEqual(badRelease.body.error, 'reservation_already_confirmed');

  // Tạo giữ hàng mới, release 2 lần (lũy đẳng) rồi cố confirm -> 409 reservation_already_released
  const rsv2 = await invokeHandler(handler, {
    method: 'POST',
    url: '/inventory/reserve',
    body: { orderId: 'ORD-11', productId: 'P1', quantity: 1, ttlSeconds: 30 },
  });
  const id2 = rsv2.body.reservationId;

  const rel1 = await invokeHandler(handler, { method: 'POST', url: `/inventory/reservations/${id2}/release` });
  assert.strictEqual(rel1.status, 200);
  assert.strictEqual(rel1.body.replayed, false);

  const rel2 = await invokeHandler(handler, { method: 'POST', url: `/inventory/reservations/${id2}/release` });
  assert.strictEqual(rel2.status, 200);
  assert.strictEqual(rel2.body.replayed, true);

  const badConfirm = await invokeHandler(handler, { method: 'POST', url: `/inventory/reservations/${id2}/confirm` });
  assert.strictEqual(badConfirm.status, 409);
  assert.strictEqual(badConfirm.body.error, 'reservation_already_released');
});
