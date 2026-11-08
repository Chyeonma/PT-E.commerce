'use strict';

/**
 * Service Registry (UDDI-Lite) — danh bạ dịch vụ lưu trong bộ nhớ.
 *
 * Mỗi bản ghi (instance) gồm: serviceName, instanceId, endpoint (http://host:port),
 * metadata, registeredAt, lastHeartbeat, expiresAt.
 *
 * Chính sách soft-state: instance phải gửi heartbeat trước khi hết TTL,
 * nếu không sẽ tự bị loại khỏi danh bạ (sweeper chạy mỗi giây).
 */

const http = require('http');

const DEFAULT_TTL_SECONDS = 10;
const MAX_TTL_SECONDS = 300;

class Registry {
  constructor({ now = () => Date.now(), logger = console } = {}) {
    this.services = new Map(); // serviceName -> Map(instanceId -> instance)
    this.now = now;
    this.logger = logger;
  }

  register({ serviceName, instanceId, host, port, endpoint, ttlSeconds, metadata }) {
    if (!serviceName || typeof serviceName !== 'string') throw badRequest('serviceName is required');
    if (!endpoint) {
      if (!host || !port) throw badRequest('endpoint or host+port is required');
      endpoint = `http://${host}:${port}`;
    }
    try { new URL(endpoint); } catch { throw badRequest('endpoint is not a valid URL'); }

    const ttl = Math.min(Math.max(Number(ttlSeconds) || DEFAULT_TTL_SECONDS, 1), MAX_TTL_SECONDS);
    instanceId = instanceId || `${serviceName}-${Math.random().toString(36).slice(2, 10)}`;

    if (!this.services.has(serviceName)) this.services.set(serviceName, new Map());
    const instances = this.services.get(serviceName);
    const now = this.now();
    const existing = instances.get(instanceId);
    const instance = {
      serviceName,
      instanceId,
      endpoint: endpoint.replace(/\/+$/, ''),
      metadata: metadata || {},
      ttlSeconds: ttl,
      registeredAt: existing ? existing.registeredAt : now,
      lastHeartbeat: now,
      expiresAt: now + ttl * 1000,
    };
    instances.set(instanceId, instance);
    this.logger.log(`[registry] ${existing ? 're-registered' : 'registered'} ${serviceName}/${instanceId} -> ${instance.endpoint} (ttl ${ttl}s)`);
    return instance;
  }

  heartbeat(serviceName, instanceId) {
    const inst = this.services.get(serviceName)?.get(instanceId);
    if (!inst) return null;
    const now = this.now();
    inst.lastHeartbeat = now;
    inst.expiresAt = now + inst.ttlSeconds * 1000;
    return inst;
  }

  deregister(serviceName, instanceId) {
    const instances = this.services.get(serviceName);
    if (!instances || !instances.delete(instanceId)) return false;
    if (instances.size === 0) this.services.delete(serviceName);
    this.logger.log(`[registry] deregistered ${serviceName}/${instanceId}`);
    return true;
  }

  /** Danh sách instance còn sống của một dịch vụ, sắp xếp ổn định theo instanceId. */
  lookup(serviceName) {
    this.sweep();
    const instances = this.services.get(serviceName);
    if (!instances) return [];
    return [...instances.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }

  list() {
    this.sweep();
    const out = {};
    for (const name of [...this.services.keys()].sort()) out[name] = this.lookup(name);
    return out;
  }

  /** Loại bỏ các instance đã hết TTL. */
  sweep() {
    const now = this.now();
    for (const [name, instances] of this.services) {
      for (const [id, inst] of instances) {
        if (inst.expiresAt <= now) {
          instances.delete(id);
          this.logger.log(`[registry] expired ${name}/${id} (no heartbeat for ${inst.ttlSeconds}s)`);
        }
      }
      if (instances.size === 0) this.services.delete(name);
    }
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(badRequest('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function view(inst) {
  return {
    serviceName: inst.serviceName,
    instanceId: inst.instanceId,
    endpoint: inst.endpoint,
    metadata: inst.metadata,
    ttlSeconds: inst.ttlSeconds,
    registeredAt: new Date(inst.registeredAt).toISOString(),
    lastHeartbeat: new Date(inst.lastHeartbeat).toISOString(),
    expiresAt: new Date(inst.expiresAt).toISOString(),
  };
}

/**
 * REST API:
 *   POST   /services/register                          đăng ký / đăng ký lại
 *   PUT    /services/:name/instances/:id/heartbeat     gia hạn TTL
 *   DELETE /services/:name/instances/:id               hủy đăng ký
 *   GET    /services                                   toàn bộ danh bạ
 *   GET    /services/:name                             các endpoint còn sống của 1 dịch vụ
 *   GET    /health
 */
function createRegistryServer({ registry = new Registry(), sweepIntervalMs = 1000 } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok', services: registry.services.size });
      }

      if (parts[0] !== 'services') return sendJson(res, 404, { error: 'not_found' });

      // POST /services/register
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'register') {
        const inst = registry.register(await readJson(req));
        return sendJson(res, 201, view(inst));
      }

      // GET /services
      if (req.method === 'GET' && parts.length === 1) {
        const all = registry.list();
        const body = {};
        for (const [name, list] of Object.entries(all)) body[name] = list.map(view);
        return sendJson(res, 200, body);
      }

      // GET /services/:name
      if (req.method === 'GET' && parts.length === 2) {
        const list = registry.lookup(parts[1]);
        return sendJson(res, 200, { serviceName: parts[1], instances: list.map(view) });
      }

      // PUT /services/:name/instances/:id/heartbeat
      if (req.method === 'PUT' && parts.length === 5 && parts[2] === 'instances' && parts[4] === 'heartbeat') {
        const inst = registry.heartbeat(parts[1], parts[3]);
        if (!inst) return sendJson(res, 404, { error: 'instance_not_found' });
        return sendJson(res, 200, view(inst));
      }

      // DELETE /services/:name/instances/:id
      if (req.method === 'DELETE' && parts.length === 4 && parts[2] === 'instances') {
        const ok = registry.deregister(parts[1], parts[3]);
        return sendJson(res, ok ? 200 : 404, ok ? { deregistered: true } : { error: 'instance_not_found' });
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.status ? 'bad_request' : 'internal_error', message: err.message });
    }
  });

  const timer = setInterval(() => registry.sweep(), sweepIntervalMs);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  server.registry = registry;
  return server;
}

module.exports = { Registry, createRegistryServer };
