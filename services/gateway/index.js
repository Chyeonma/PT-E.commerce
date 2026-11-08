'use strict';

const fs = require('fs');
const path = require('path');
const { createGatewayServer } = require('./gateway');

const PORT = Number(process.env.PORT || 8080);
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:4000';
const ROUTES_FILE = process.env.ROUTES_FILE || path.join(__dirname, 'routes.json');

const routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));

const server = createGatewayServer({
  registryUrl: REGISTRY_URL,
  routes,
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 5000),
  cacheTtlMs: Number(process.env.REGISTRY_CACHE_TTL_MS || 2000),
  quarantineMs: Number(process.env.QUARANTINE_MS || 5000),
});

server.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT}, registry=${REGISTRY_URL}`);
  for (const r of routes) console.log(`[gateway] route ${r.prefix}/* -> ${r.service}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
