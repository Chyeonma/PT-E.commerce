'use strict';

/**
 * Registry client dùng chung cho mọi backend (Inventory, Pricing, Order, Payment...).
 *
 * Cách dùng tối thiểu trong một service Node.js:
 *
 *   const { RegistryClient } = require('../../packages/registry-client');
 *   const client = new RegistryClient({
 *     registryUrl: process.env.REGISTRY_URL,   // vd: http://registry:4000
 *     serviceName: 'inventory-service',
 *     port: 3000,
 *   });
 *   await client.start();   // đăng ký + gửi heartbeat định kỳ
 *   // khi tắt: await client.stop();  (tự gọi khi nhận SIGTERM/SIGINT nếu handleSignals = true)
 *
 * Không phụ thuộc thư viện ngoài (chỉ dùng fetch có sẵn trong Node >= 18).
 */

const os = require('os');

function detectHostIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RegistryClient {
  constructor(opts = {}) {
    if (!opts.registryUrl) throw new Error('registryUrl is required');
    if (!opts.serviceName) throw new Error('serviceName is required');
    if (!opts.port) throw new Error('port is required');

    this.registryUrl = opts.registryUrl.replace(/\/+$/, '');
    this.serviceName = opts.serviceName;
    this.host = opts.host || process.env.ADVERTISE_HOST || detectHostIp();
    this.port = Number(opts.port);
    this.instanceId = opts.instanceId || `${this.serviceName}-${os.hostname()}-${process.pid}`;
    this.ttlSeconds = Number(opts.ttlSeconds || 10);
    // Gửi heartbeat ở 1/3 TTL để chịu được mất 1-2 nhịp.
    this.heartbeatMs = Number(opts.heartbeatMs || Math.max(1000, (this.ttlSeconds * 1000) / 3));
    this.metadata = opts.metadata || {};
    this.logger = opts.logger || console;
    this.handleSignals = opts.handleSignals !== false;

    this._timer = null;
    this._stopped = false;
  }

  get endpoint() {
    return `http://${this.host}:${this.port}`;
  }

  async _request(method, path, body) {
    const res = await fetch(this.registryUrl + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  }

  async register() {
    const { status, data } = await this._request('POST', '/services/register', {
      serviceName: this.serviceName,
      instanceId: this.instanceId,
      host: this.host,
      port: this.port,
      ttlSeconds: this.ttlSeconds,
      metadata: this.metadata,
    });
    if (status >= 300) throw new Error(`register failed: HTTP ${status} ${JSON.stringify(data)}`);
    this.logger.log(`[registry-client] registered ${this.instanceId} -> ${this.endpoint}`);
    return data;
  }

  async heartbeat() {
    const path = `/services/${encodeURIComponent(this.serviceName)}/instances/${encodeURIComponent(this.instanceId)}/heartbeat`;
    const { status } = await this._request('PUT', path);
    if (status === 404) {
      // Registry đã quên instance (hết TTL hoặc registry khởi động lại) -> đăng ký lại.
      this.logger.warn(`[registry-client] heartbeat 404, re-registering ${this.instanceId}`);
      await this.register();
    } else if (status >= 300) {
      throw new Error(`heartbeat failed: HTTP ${status}`);
    }
  }

  async deregister() {
    const path = `/services/${encodeURIComponent(this.serviceName)}/instances/${encodeURIComponent(this.instanceId)}`;
    try {
      await this._request('DELETE', path);
      this.logger.log(`[registry-client] deregistered ${this.instanceId}`);
    } catch (err) {
      this.logger.warn(`[registry-client] deregister failed: ${err.message}`);
    }
  }

  /** Đăng ký (thử lại tới khi registry sẵn sàng) rồi bắt đầu heartbeat định kỳ. */
  async start() {
    this._stopped = false;
    let delay = 500;
    for (;;) {
      try {
        await this.register();
        break;
      } catch (err) {
        if (this._stopped) return;
        this.logger.warn(`[registry-client] registry not ready (${err.message}), retry in ${delay}ms`);
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
      }
    }

    this._timer = setInterval(() => {
      this.heartbeat().catch((err) => this.logger.warn(`[registry-client] heartbeat error: ${err.message}`));
    }, this.heartbeatMs);
    this._timer.unref();

    if (this.handleSignals) {
      const shutdown = async () => {
        await this.stop();
        process.exit(0);
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    }
  }

  async stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    await this.deregister();
  }
}

module.exports = { RegistryClient, detectHostIp };
