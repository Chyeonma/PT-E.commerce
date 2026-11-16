'use strict';

/**
 * Inventory Service (Người 2) — Dịch vụ tồn kho stateless được nhân bản,
 * kèm bộ nhớ đệm giữ hàng tạm thời theo cơ chế soft-state (TTL, Mục 3.4.1).
 *
 * Đặc điểm chính:
 *   - Mọi bản sao cùng truy cập kho trạng thái qua `FileStore` (atomic lock + atomic write)
 *     để tránh bán vượt tồn kho (overselling) khi có yêu cầu đồng thời.
 *   - Bản ghi giữ hàng (reservation) có thời hạn sống `ttlSeconds` (mặc định 30s).
 *   - Khi quá hạn (`now >= expiresAt`), trạng thái tự chuyển sang `EXPIRED` và lượng hàng
 *     đang giữ tự động được giải phóng về `availableStock`.
 *   - Hỗ trợ `Idempotency-Key` để an toàn khi Gateway hoặc Order Orchestrator retry.
 */

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { FileStore } = require('../../packages/file-store');

const DEFAULT_RESERVATION_TTL_SECONDS = 30;
const MAX_RESERVATION_TTL_SECONDS = 3600;

const DEFAULT_STOCK = {
  P1: { productId: 'P1', name: 'Mechanical Keyboard', totalStock: 50, soldStock: 0 },
  P2: { productId: 'P2', name: 'Wireless Gaming Mouse', totalStock: 80, soldStock: 0 },
  P3: { productId: 'P3', name: '27-inch 4K Monitor', totalStock: 20, soldStock: 0 },
  P4: { productId: 'P4', name: 'USB-C Docking Station', totalStock: 35, soldStock: 0 },
  P_LAST: { productId: 'P_LAST', name: 'Limited Edition GPU', totalStock: 1, soldStock: 0 },
};

function httpError(status, code, message, extra = {}) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  err.extra = extra;
  return err;
}

function formatReservation(r) {
  return {
    reservationId: r.reservationId,
    orderId: r.orderId,
    productId: r.productId,
    quantity: r.quantity,
    status: r.status,
    ttlSeconds: r.ttlSeconds,
    idempotencyKey: r.idempotencyKey || null,
    createdAt: new Date(r.createdAt).toISOString(),
    expiresAt: new Date(r.expiresAt).toISOString(),
    confirmedAt: r.confirmedAt ? new Date(r.confirmedAt).toISOString() : null,
    releasedAt: r.releasedAt ? new Date(r.releasedAt).toISOString() : null,
    expiredAt: r.expiredAt ? new Date(r.expiredAt).toISOString() : null,
  };
}

class InventoryStore {
  constructor({
    filePath = process.env.INVENTORY_DATA_FILE || path.join(process.cwd(), 'data', 'inventory.json'),
    seedStock = DEFAULT_STOCK,
    defaultTtlSeconds = Number(process.env.RESERVATION_TTL_SECONDS || DEFAULT_RESERVATION_TTL_SECONDS),
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.now = now;
    this.seedStock = seedStock;
    this.defaultTtlSeconds = defaultTtlSeconds;
    this.logger = logger;
    this.fileStore = new FileStore({
      filePath,
      initialData: { products: {}, reservations: {} },
    });
  }

  _ensureSeeded(state) {
    if (!state.products) state.products = {};
    if (!state.reservations) state.reservations = {};
    if (Object.keys(state.products).length === 0 && this.seedStock) {
      for (const [id, item] of Object.entries(this.seedStock)) {
        state.products[id] = {
          productId: id,
          name: item.name || id,
          totalStock: Number(item.totalStock ?? 0),
          soldStock: Number(item.soldStock ?? 0),
        };
      }
    }
  }

  /**
   * Quét và đánh dấu EXPIRED cho các bản ghi RESERVED đã quá hạn TTL.
   * Trả về danh sách reservationId vừa hết hạn.
   */
  _sweepUnlocked(state) {
    this._ensureSeeded(state);
    const now = this.now();
    const expiredIds = [];
    for (const r of Object.values(state.reservations)) {
      if (r.status === 'RESERVED' && r.expiresAt <= now) {
        r.status = 'EXPIRED';
        r.expiredAt = now;
        expiredIds.push(r.reservationId);
      }
    }
    return expiredIds;
  }

  _computeStockView(state, productId) {
    const product = state.products[productId];
    if (!product) return null;
    const now = this.now();
    let reservedStock = 0;
    for (const r of Object.values(state.reservations)) {
      if (r.productId === productId && r.status === 'RESERVED' && r.expiresAt > now) {
        reservedStock += r.quantity;
      }
    }
    const availableStock = Math.max(0, product.totalStock - reservedStock);
    return {
      productId: product.productId,
      name: product.name,
      totalStock: product.totalStock,
      reservedStock,
      availableStock,
      soldStock: product.soldStock || 0,
    };
  }

  async sweep() {
    return this.fileStore.transact((state) => this._sweepUnlocked(state));
  }

  async listStock() {
    return this.fileStore.transact((state) => {
      this._sweepUnlocked(state);
      return Object.keys(state.products)
        .sort()
        .map((id) => this._computeStockView(state, id));
    });
  }

  async getStock(productId) {
    return this.fileStore.transact((state) => {
      this._sweepUnlocked(state);
      const view = this._computeStockView(state, productId);
      if (!view) {
        throw httpError(404, 'product_not_found', `Product ${productId} not found`, { productId });
      }
      return view;
    });
  }

  async setStock(productId, { name, totalStock }) {
    if (!productId || typeof productId !== 'string') {
      throw httpError(400, 'invalid_product_id', 'productId is required');
    }
    const total = Number(totalStock);
    if (!Number.isFinite(total) || total < 0 || !Number.isInteger(total)) {
      throw httpError(400, 'invalid_total_stock', 'totalStock must be a non-negative integer');
    }
    return this.fileStore.transact((state) => {
      this._sweepUnlocked(state);
      const existing = state.products[productId] || { soldStock: 0 };
      state.products[productId] = {
        productId,
        name: name !== undefined ? String(name) : existing.name || productId,
        totalStock: total,
        soldStock: existing.soldStock || 0,
      };
      return this._computeStockView(state, productId);
    });
  }

  async reserve({ orderId, productId, quantity, ttlSeconds, idempotencyKey, reservationId }) {
    if (!productId || typeof productId !== 'string') {
      throw httpError(400, 'invalid_product_id', 'productId is required');
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      throw httpError(400, 'invalid_quantity', 'quantity must be a positive integer');
    }
    const rawTtl = ttlSeconds !== undefined ? Number(ttlSeconds) : this.defaultTtlSeconds;
    const ttl = Math.min(Math.max(Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : this.defaultTtlSeconds, 1), MAX_RESERVATION_TTL_SECONDS);

    return this.fileStore.transact((state) => {
      this._sweepUnlocked(state);

      // Kiểm tra Idempotency-Key trước để chống giữ hàng lặp khi retry
      if (idempotencyKey) {
        const existing = Object.values(state.reservations).find((r) => r.idempotencyKey === idempotencyKey);
        if (existing) {
          return {
            reservation: formatReservation(existing),
            stock: this._computeStockView(state, existing.productId),
            replayed: true,
          };
        }
      }

      const stockView = this._computeStockView(state, productId);
      if (!stockView) {
        throw httpError(404, 'product_not_found', `Product ${productId} not found`, { productId });
      }

      if (stockView.availableStock < qty) {
        throw httpError(
          409,
          'insufficient_stock',
          `Insufficient available stock for ${productId}: requested ${qty}, available ${stockView.availableStock}`,
          {
            productId,
            requested: qty,
            availableStock: stockView.availableStock,
            reservedStock: stockView.reservedStock,
            totalStock: stockView.totalStock,
          }
        );
      }

      const now = this.now();
      const id = reservationId || `rsv-${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      const record = {
        reservationId: id,
        orderId: orderId || idempotencyKey || `ord-${id}`,
        productId,
        quantity: qty,
        status: 'RESERVED',
        ttlSeconds: ttl,
        idempotencyKey: idempotencyKey || null,
        createdAt: now,
        expiresAt: now + ttl * 1000,
        confirmedAt: null,
        releasedAt: null,
        expiredAt: null,
      };
      state.reservations[id] = record;

      return {
        reservation: formatReservation(record),
        stock: this._computeStockView(state, productId),
        replayed: false,
      };
    });
  }

  async confirm(reservationId) {
    if (!reservationId) throw httpError(400, 'invalid_reservation_id', 'reservationId is required');
    return this.fileStore.transact((state) => {
      this._sweepUnlocked(state);
      const record = state.reservations[reservationId];
      if (!record) {
        throw httpError(404, 'reservation_not_found', `Reservation ${reservationId} not found`, { reservationId });
      }

      // Lũy đẳng: nếu đã CONFIRMED trước đó thì trả lại kết quả cũ, không trừ kho lần 2
      if (record.status === 'CONFIRMED') {
        return {
          reservation: formatReservation(record),
          stock: this._computeStockView(state, record.productId),
          replayed: true,
        };
      }

      if (record.status === 'EXPIRED') {
        throw httpError(409, 'reservation_expired', `Reservation ${reservationId} has expired`, {
          reservationId,
          expiresAt: new Date(record.expiresAt).toISOString(),
        });
      }

      if (record.status === 'RELEASED') {
        throw httpError(409, 'reservation_already_released', `Reservation ${reservationId} was already released`, {
          reservationId,
        });
      }

      const product = state.products[record.productId];
      if (!product || product.totalStock < record.quantity) {
        throw httpError(409, 'insufficient_stock', `Cannot confirm reservation ${reservationId}: insufficient total stock`);
      }

      product.totalStock -= record.quantity;
      product.soldStock = (product.soldStock || 0) + record.quantity;
      record.status = 'CONFIRMED';
      record.confirmedAt = this.now();

      return {
        reservation: formatReservation(record),
        stock: this._computeStockView(state, record.productId),
        replayed: false,
      };
    });
  }

  async release(reservationId) {
    if (!reservationId) throw httpError(400, 'invalid_reservation_id', 'reservationId is required');
    return this.fileStore.transact((state) => {
      this._sweepUnlocked(state);
      const record = state.reservations[reservationId];
      if (!record) {
        throw httpError(404, 'reservation_not_found', `Reservation ${reservationId} not found`, { reservationId });
      }

      // Lũy đẳng: nếu đã RELEASED hoặc EXPIRED thì lượng hàng đã được giải phóng rồi
      if (record.status === 'RELEASED' || record.status === 'EXPIRED') {
        return {
          reservation: formatReservation(record),
          stock: this._computeStockView(state, record.productId),
          replayed: true,
        };
      }

      if (record.status === 'CONFIRMED') {
        throw httpError(
          409,
          'reservation_already_confirmed',
          `Reservation ${reservationId} is already confirmed and cannot be released`,
          { reservationId }
        );
      }

      record.status = 'RELEASED';
      record.releasedAt = this.now();

      return {
        reservation: formatReservation(record),
        stock: this._computeStockView(state, record.productId),
        replayed: false,
      };
    });
  }

  async getReservation(reservationId) {
    return this.fileStore.transact((state) => {
      this._sweepUnlocked(state);
      const record = state.reservations[reservationId];
      if (!record) {
        throw httpError(404, 'reservation_not_found', `Reservation ${reservationId} not found`, { reservationId });
      }
      return formatReservation(record);
    });
  }

  async listReservations({ orderId, productId, status } = {}) {
    return this.fileStore.transact((state) => {
      this._sweepUnlocked(state);
      return Object.values(state.reservations)
        .filter((r) => {
          if (orderId && r.orderId !== orderId) return false;
          if (productId && r.productId !== productId) return false;
          if (status && r.status !== status) return false;
          return true;
        })
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(formatReservation);
    });
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, 'invalid_json', 'Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createInventoryHandler({
  store = new InventoryStore(),
  instanceId = 'inventory-service-local',
  logger = console,
} = {}) {
  return async function handleInventoryRequest(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok', service: 'inventory-service', instanceId });
      }

      // Hỗ trợ cả tiền tố /inventory/... (qua Gateway) hoặc gọi trực tiếp /stock/...
      const normalized = parts[0] === 'inventory' ? parts.slice(1) : parts;

      // GET /inventory/stock
      if (req.method === 'GET' && (normalized.length === 0 || (normalized.length === 1 && normalized[0] === 'stock'))) {
        const products = await store.listStock();
        return sendJson(res, 200, { service: 'inventory-service', instanceId, products });
      }

      // GET /inventory/stock/:productId
      if (req.method === 'GET' && normalized.length === 2 && normalized[0] === 'stock') {
        const stock = await store.getStock(normalized[1]);
        return sendJson(res, 200, { service: 'inventory-service', instanceId, ...stock });
      }

      // PUT /inventory/stock/:productId
      if (req.method === 'PUT' && normalized.length === 2 && normalized[0] === 'stock') {
        const body = await readJson(req);
        const stock = await store.setStock(normalized[1], body);
        logger.log(`[${instanceId}] updated stock ${stock.productId} -> total=${stock.totalStock}`);
        return sendJson(res, 200, { service: 'inventory-service', instanceId, ...stock });
      }

      // POST /inventory/reserve (hoặc POST /inventory/reservations)
      if (
        req.method === 'POST' &&
        normalized.length === 1 &&
        (normalized[0] === 'reserve' || normalized[0] === 'reservations')
      ) {
        const body = await readJson(req);
        const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey || null;
        const result = await store.reserve({
          orderId: body.orderId,
          productId: body.productId || body.sku,
          quantity: body.quantity,
          ttlSeconds: body.ttlSeconds,
          reservationId: body.reservationId,
          idempotencyKey,
        });
        logger.log(
          `[${instanceId}] ${result.replayed ? 'replayed' : 'reserved'} ${result.reservation.reservationId} (${result.reservation.productId} x${result.reservation.quantity}, ttl=${result.reservation.ttlSeconds}s)`
        );
        return sendJson(res, result.replayed ? 200 : 201, {
          service: 'inventory-service',
          instanceId,
          replayed: result.replayed,
          ...result.reservation,
          stock: result.stock,
        });
      }

      // GET /inventory/reservations
      if (req.method === 'GET' && normalized.length === 1 && normalized[0] === 'reservations') {
        const reservations = await store.listReservations({
          orderId: url.searchParams.get('orderId') || undefined,
          productId: url.searchParams.get('productId') || undefined,
          status: url.searchParams.get('status') || undefined,
        });
        return sendJson(res, 200, { service: 'inventory-service', instanceId, reservations });
      }

      // GET /inventory/reservations/:id
      if (req.method === 'GET' && normalized.length === 2 && normalized[0] === 'reservations') {
        const reservation = await store.getReservation(normalized[1]);
        return sendJson(res, 200, { service: 'inventory-service', instanceId, ...reservation });
      }

      // POST /inventory/reservations/:id/confirm (hoặc POST /inventory/confirm)
      if (
        req.method === 'POST' &&
        ((normalized.length === 3 && normalized[0] === 'reservations' && normalized[2] === 'confirm') ||
          (normalized.length === 1 && normalized[0] === 'confirm'))
      ) {
        const body = normalized.length === 1 ? await readJson(req) : {};
        const reservationId = normalized.length === 3 ? normalized[1] : body.reservationId;
        const result = await store.confirm(reservationId);
        logger.log(`[${instanceId}] confirmed ${reservationId}`);
        return sendJson(res, 200, {
          service: 'inventory-service',
          instanceId,
          replayed: result.replayed,
          ...result.reservation,
          stock: result.stock,
        });
      }

      // POST /inventory/reservations/:id/release (hoặc POST /inventory/release hoặc DELETE /inventory/reservations/:id)
      if (
        (req.method === 'POST' &&
          ((normalized.length === 3 && normalized[0] === 'reservations' && normalized[2] === 'release') ||
            (normalized.length === 1 && normalized[0] === 'release'))) ||
        (req.method === 'DELETE' && normalized.length === 2 && normalized[0] === 'reservations')
      ) {
        const body = req.method === 'POST' && normalized.length === 1 ? await readJson(req) : {};
        const reservationId = normalized.length >= 2 ? normalized[1] : body.reservationId;
        const result = await store.release(reservationId);
        logger.log(`[${instanceId}] released ${reservationId}`);
        return sendJson(res, 200, {
          service: 'inventory-service',
          instanceId,
          replayed: result.replayed,
          ...result.reservation,
          stock: result.stock,
        });
      }

      return sendJson(res, 404, { error: 'not_found', path: url.pathname, instanceId });
    } catch (err) {
      const status = err.status || 500;
      return sendJson(res, status, {
        error: err.code || (status === 400 ? 'bad_request' : 'internal_error'),
        message: err.message,
        ...(err.extra || {}),
        instanceId,
      });
    }
  };
}

function createInventoryServer(opts = {}) {
  const store = opts.store || new InventoryStore(opts);
  const handler = createInventoryHandler({ ...opts, store });
  const server = http.createServer(handler);
  const sweepIntervalMs = opts.sweepIntervalMs || 1000;
  const timer = setInterval(() => {
    store.sweep().catch(() => {});
  }, sweepIntervalMs);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  server.inventory = store;
  server.handler = handler;
  return server;
}

module.exports = {
  InventoryStore,
  createInventoryHandler,
  createInventoryServer,
  DEFAULT_STOCK,
  DEFAULT_RESERVATION_TTL_SECONDS,
};
