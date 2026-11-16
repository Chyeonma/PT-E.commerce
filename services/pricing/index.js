'use strict';

const os = require('node:os');
const path = require('node:path');
const { RegistryClient } = require('../../packages/registry-client');
const { PricingStore, createPricingServer } = require('./pricing');

const SERVICE_NAME = process.env.SERVICE_NAME || 'pricing-service';
const PORT = Number(process.env.PORT || 3002);
const REGISTRY_URL = process.env.REGISTRY_URL || 'http://localhost:4000';
const INSTANCE_ID = process.env.INSTANCE_ID || `${SERVICE_NAME}-${os.hostname()}-${process.pid}`;
const DATA_FILE = process.env.PRICING_DATA_FILE || path.join(process.cwd(), 'data', 'pricing.json');

const store = new PricingStore({ filePath: DATA_FILE });
const server = createPricingServer({ store, instanceId: INSTANCE_ID });

server.listen(PORT, async () => {
  console.log(`[${INSTANCE_ID}] pricing-service listening on :${PORT} (data: ${DATA_FILE})`);
  const client = new RegistryClient({
    registryUrl: REGISTRY_URL,
    serviceName: SERVICE_NAME,
    instanceId: INSTANCE_ID,
    port: PORT,
    ttlSeconds: Number(process.env.REGISTRY_TTL_SECONDS || 10),
    metadata: { role: 'pricing', stateless: true },
  });
  await client.start();
});
