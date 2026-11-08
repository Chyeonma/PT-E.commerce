'use strict';

/**
 * API Gateway / bộ chuyển mạch logic (Hình 3-12).
 *
 * Định tuyến 2 bước:
 *   1. Xác định dịch vụ đích theo tiền tố đường dẫn (bảng route).
 *   2. Tra cứu Registry lấy danh sách bản sao, chọn 1 bản sao bằng round-robin.
 *
 * Khi bản sao được chọn không kết nối được (lỗi mạng / timeout) gateway thử bản sao kế tiếp,
 * NHƯNG chỉ với request an toàn để gửi lại: method lũy đẳng (GET, HEAD, PUT, DELETE, OPTIONS)
 * hoặc request có header Idempotency-Key (Mục 2.2.1). POST không có Idempotency-Key sẽ không
 * bị gửi lại để tránh tác dụng nghiệp vụ lặp (vd. trừ tiền 2 lần).
 */

const http = require('http');

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);
const MAX_BODY_BYTES = 1024 * 1024;

class RegistryLookup {
  constructor({ registryUrl, cacheTtlMs = 2000, logger = console }) {
    this.registryUrl = registryUrl.replace(/\/+$/, '');
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map(); // serviceName -> { instances, fetchedAt }
    this.down = new Map(); // instanceId -> thời điểm hết cách ly
    this.logger = logger;
  }

  invalidate(serviceName) {
    this.cache.delete(serviceName);
  }

  /**
   * Cách ly tạm thời 1 instance vừa lỗi mạng (passive health check), để các request sau
   * không phải chờ timeout lại trong lúc registry chưa loại nó (chưa hết TTL).
   */
  markDown(instanceId, ms) {
    this.down.set(instanceId, Date.now() + ms);
  }

  filterHealthy(instances) {
    const now = Date.now();
    const healthy = instances.filter((i) => !(this.down.get(i.instanceId) > now));
    // Nếu tất cả đều đang bị cách ly thì vẫn thử tất cả (có thể đã hồi phục).
    return healthy.length ? healthy : instances;
  }

  async getInstances(serviceName) {
    const cached = this.cache.get(serviceName);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) return cached.instances;
    try {
      const res = await fetch(`${this.registryUrl}/services/${encodeURIComponent(serviceName)}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
      const body = await res.json();
      const instances = body.instances || [];
      this.cache.set(serviceName, { instances, fetchedAt: Date.now() });
      return instances;
    } catch (err) {
      // Registry tạm thời không truy cập được: dùng tạm danh sách cũ (nếu có).
      if (cached) {
        this.logger.warn(`[gateway] registry lookup failed (${err.message}), using stale list for ${serviceName}`);
        return cached.instances;
      }
      const e = new Error(`registry unavailable: ${err.message}`);
      e.code = 'REGISTRY_UNAVAILABLE';
      throw e;
    }
  }
}

class RoundRobin {
  constructor() {
    this.counters = new Map();
  }

  /** Trả về danh sách instance theo thứ tự thử: bắt đầu từ vị trí round-robin hiện tại. */
  order(serviceName, instances) {
    if (instances.length === 0) return [];
    const n = this.counters.get(serviceName) || 0;
    this.counters.set(serviceName, (n + 1) % 1_000_000_000);
    const start = n % instances.length;
    return instances.slice(start).concat(instances.slice(0, start));
  }
}

function matchRoute(routes, pathname) {
  // Ưu tiên tiền tố dài nhất.
  let best = null;
  for (const r of routes) {
    if (pathname === r.prefix || pathname.startsWith(r.prefix + '/')) {
      if (!best || r.prefix.length > best.prefix.length) best = r;
    }
  }
  return best;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        const e = new Error('payload too large');
        e.status = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Gửi 1 request tới 1 instance. Reject khi lỗi mạng/timeout (chưa nhận được phản hồi). */
function forwardOnce({ instance, method, path, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, instance.endpoint + '/');
    const req = http.request(target, { method, headers, timeout: timeoutMs }, resolve);
    req.on('timeout', () => req.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

function createGatewayServer({
  registryUrl,
  routes,
  upstreamTimeoutMs = 5000,
  cacheTtlMs = 2000,
  quarantineMs = 5000,
  logger = console,
} = {}) {
  if (!registryUrl) throw new Error('registryUrl is required');
  const lookup = new RegistryLookup({ registryUrl, cacheTtlMs, logger });
  const rr = new RoundRobin();
  let requestSeq = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway');
    const requestId = req.headers['x-request-id'] || `gw-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;

    // --- Endpoint nội bộ của gateway ---
    if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    if (url.pathname === '/gateway/routes') {
      const out = [];
      for (const r of routes) {
        let instances = [];
        try { instances = await lookup.getInstances(r.service); } catch { /* registry down */ }
        out.push({ ...r, instances: instances.map((i) => ({ instanceId: i.instanceId, endpoint: i.endpoint })) });
      }
      return sendJson(res, 200, { routes: out });
    }

    // --- Bước 1: xác định dịch vụ ---
    const route = matchRoute(routes, url.pathname);
    if (!route) return sendJson(res, 404, { error: 'route_not_found', path: url.pathname, requestId });

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, err.status || 400, { error: 'bad_request', message: err.message, requestId });
    }

    // --- Bước 2: tra cứu registry + round-robin ---
    let instances;
    try {
      instances = lookup.filterHealthy(await lookup.getInstances(route.service));
    } catch (err) {
      return sendJson(res, 503, { error: 'registry_unavailable', message: err.message, requestId });
    }
    if (instances.length === 0) {
      return sendJson(res, 503, { error: 'no_available_instance', service: route.service, requestId });
    }

    const method = req.method.toUpperCase();
    const idempotencyKey = req.headers['idempotency-key'];
    const retryable = IDEMPOTENT_METHODS.has(method) || Boolean(idempotencyKey);
    const candidates = rr.order(route.service, instances);
    const attempts = retryable ? candidates : candidates.slice(0, 1);

    let upstreamPath = url.pathname;
    if (route.stripPrefix) upstreamPath = upstreamPath.slice(route.prefix.length) || '/';
    upstreamPath += url.search;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    headers['x-request-id'] = requestId;
    headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-prefix'] = route.prefix;
    if (body.length) headers['content-length'] = String(body.length);
    // Header Idempotency-Key (nếu có) được giữ nguyên ở trên và chuyển tiếp cho backend.

    const tried = [];
    for (const instance of attempts) {
      tried.push(instance.instanceId);
      try {
        const upstreamRes = await forwardOnce({
          instance, method, path: upstreamPath, headers, body, timeoutMs: upstreamTimeoutMs,
        });
        const outHeaders = {};
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === 'content-length') outHeaders[k] = v;
        }
        outHeaders['x-request-id'] = requestId;
        outHeaders['x-gateway-service'] = route.service;
        outHeaders['x-served-by'] = instance.instanceId;
        outHeaders['x-gateway-attempts'] = String(tried.length);
        res.writeHead(upstreamRes.statusCode, outHeaders);
        upstreamRes.pipe(res);
        logger.log(`[gateway] ${requestId} ${method} ${url.pathname} -> ${route.service}/${instance.instanceId} ${upstreamRes.statusCode} (attempt ${tried.length})`);
        return;
      } catch (err) {
        logger.warn(`[gateway] ${requestId} ${method} ${url.pathname} -> ${route.service}/${instance.instanceId} failed: ${err.code || err.message}`);
        // Instance có thể đã chết: buộc tra cứu lại registry ở request sau.
        lookup.invalidate(route.service);
        lookup.markDown(instance.instanceId, quarantineMs);
      }
    }

    return sendJson(res, 502, {
      error: 'upstream_unavailable',
      service: route.service,
      tried,
      retried: retryable,
      message: retryable
        ? 'all instances failed'
        : 'instance failed; request not retried because it is not idempotent (send an Idempotency-Key header to allow retry)',
      requestId,
    });
  });

  server.lookup = lookup;
  return server;
}

module.exports = { createGatewayServer, matchRoute, RoundRobin, RegistryLookup };
