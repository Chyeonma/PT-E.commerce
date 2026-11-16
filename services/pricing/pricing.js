'use strict';

/**
 * Pricing Service (Người 2) — Dịch vụ định giá sản phẩm stateless, được nhân bản.
 *
 * Tất cả các bản sao cùng đọc/ghi qua `FileStore` trên shared volume để đảm bảo
 * giá sản phẩm luôn nhất quán giữa mọi replica.
 *
 * REST API:
 *   GET  /health                          kiểm tra sống
 *   GET  /pricing/prices                  danh sách toàn bộ sản phẩm và giá
 *   GET  /pricing/prices/:productId       lấy giá 1 sản phẩm (hỗ trợ ?quantity=N)
 *   GET  /pricing/:productId              bí danh ngắn gọn cho GetPrice
 *   PUT  /pricing/prices/:productId       thêm mới hoặc cập nhật giá sản phẩm
 *   POST /pricing/quote                   tính giá cho 1 sản phẩm hoặc danh sách items
 */

const http = require('node:http');
const path = require('node:path');
const { FileStore } = require('../../packages/file-store');

const DEFAULT_PRODUCTS = {
  P1: { productId: 'P1', name: 'Mechanical Keyboard', unitPrice: 1500000, currency: 'VND' },
  P2: { productId: 'P2', name: 'Wireless Gaming Mouse', unitPrice: 850000, currency: 'VND' },
  P3: { productId: 'P3', name: '27-inch 4K Monitor', unitPrice: 7200000, currency: 'VND' },
  P4: { productId: 'P4', name: 'USB-C Docking Station', unitPrice: 1950000, currency: 'VND' },
  P_LAST: { productId: 'P_LAST', name: 'Limited Edition GPU', unitPrice: 25000000, currency: 'VND' },
};

function httpError(status, code, message, extra = {}) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  err.extra = extra;
  return err;
}

class PricingStore {
  constructor({
    filePath = process.env.PRICING_DATA_FILE || path.join(process.cwd(), 'data', 'pricing.json'),
    seedProducts = DEFAULT_PRODUCTS,
    now = () => Date.now(),
  } = {}) {
    this.now = now;
    this.seedProducts = seedProducts;
    this.fileStore = new FileStore({
      filePath,
      initialData: { products: {} },
    });
  }

  _ensureSeeded(state) {
    if (!state.products) state.products = {};
    if (Object.keys(state.products).length === 0 && this.seedProducts) {
      const ts = new Date(this.now()).toISOString();
      for (const [id, item] of Object.entries(this.seedProducts)) {
        state.products[id] = {
          productId: id,
          name: item.name || id,
          unitPrice: Number(item.unitPrice),
          currency: item.currency || 'VND',
          updatedAt: ts,
        };
      }
    }
  }

  async listPrices() {
    return this.fileStore.transact((state) => {
      this._ensureSeeded(state);
      return Object.values(state.products).sort((a, b) => a.productId.localeCompare(b.productId));
    });
  }

  async getPrice(productId, quantity = 1) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      throw httpError(400, 'invalid_quantity', 'quantity must be a positive integer');
    }
    return this.fileStore.transact((state) => {
      this._ensureSeeded(state);
      const product = state.products[productId];
      if (!product) {
        throw httpError(404, 'product_not_found', `Product ${productId} not found`, { productId });
      }
      return {
        ...product,
        quantity: qty,
        totalPrice: product.unitPrice * qty,
      };
    });
  }

  async upsertPrice(productId, { name, unitPrice, currency }) {
    if (!productId || typeof productId !== 'string') {
      throw httpError(400, 'invalid_product_id', 'productId is required');
    }
    const price = Number(unitPrice);
    if (!Number.isFinite(price) || price < 0) {
      throw httpError(400, 'invalid_unit_price', 'unitPrice must be a non-negative number');
    }
    return this.fileStore.transact((state) => {
      this._ensureSeeded(state);
      const existing = state.products[productId] || {};
      const updated = {
        productId,
        name: name !== undefined ? String(name) : existing.name || productId,
        unitPrice: price,
        currency: currency || existing.currency || 'VND',
        updatedAt: new Date(this.now()).toISOString(),
      };
      state.products[productId] = updated;
      return updated;
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

function createPricingHandler({
  store = new PricingStore(),
  instanceId = 'pricing-service-local',
  logger = console,
} = {}) {
  return async function handlePricingRequest(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok', service: 'pricing-service', instanceId });
      }

      // Cho phép cả tiền tố /pricing/... (qua Gateway) hoặc gọi trực tiếp /prices/...
      const normalized = parts[0] === 'pricing' ? parts.slice(1) : parts;

      // GET /pricing/prices
      if (req.method === 'GET' && (normalized.length === 0 || (normalized.length === 1 && normalized[0] === 'prices'))) {
        const products = await store.listPrices();
        return sendJson(res, 200, { service: 'pricing-service', instanceId, products });
      }

      // GET /pricing/prices/:productId hoặc GET /pricing/:productId
      if (
        req.method === 'GET' &&
        ((normalized.length === 2 && normalized[0] === 'prices') ||
          (normalized.length === 1 && normalized[0] !== 'prices' && normalized[0] !== 'quote'))
      ) {
        const productId = normalized.length === 2 ? normalized[1] : normalized[0];
        const qtyParam = url.searchParams.get('quantity');
        const quantity = qtyParam != null ? Number(qtyParam) : 1;
        const quote = await store.getPrice(productId, quantity);
        return sendJson(res, 200, { service: 'pricing-service', instanceId, ...quote });
      }

      // PUT /pricing/prices/:productId
      if (req.method === 'PUT' && normalized.length === 2 && normalized[0] === 'prices') {
        const body = await readJson(req);
        const updated = await store.upsertPrice(normalized[1], body);
        logger.log(`[${instanceId}] updated price ${updated.productId} -> ${updated.unitPrice} ${updated.currency}`);
        return sendJson(res, 200, { service: 'pricing-service', instanceId, ...updated });
      }

      // POST /pricing/quote
      if (req.method === 'POST' && normalized.length === 1 && normalized[0] === 'quote') {
        const body = await readJson(req);
        if (Array.isArray(body.items)) {
          const items = [];
          let totalAmount = 0;
          let currency = 'VND';
          for (const item of body.items) {
            const q = await store.getPrice(item.productId || item.sku, item.quantity ?? 1);
            items.push(q);
            totalAmount += q.totalPrice;
            currency = q.currency;
          }
          return sendJson(res, 200, { service: 'pricing-service', instanceId, items, totalAmount, currency });
        }
        const productId = body.productId || body.sku;
        if (!productId) throw httpError(400, 'invalid_product_id', 'productId is required');
        const quote = await store.getPrice(productId, body.quantity ?? 1);
        return sendJson(res, 200, { service: 'pricing-service', instanceId, ...quote });
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

function createPricingServer(opts = {}) {
  const store = opts.store || new PricingStore(opts);
  const handler = createPricingHandler({ ...opts, store });
  const server = http.createServer(handler);
  server.pricing = store;
  server.handler = handler;
  return server;
}

module.exports = { PricingStore, createPricingHandler, createPricingServer, DEFAULT_PRODUCTS };
