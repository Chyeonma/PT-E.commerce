'use strict';

const { createRegistryServer } = require('./registry');

const PORT = Number(process.env.PORT || 4000);

const server = createRegistryServer();
server.listen(PORT, () => console.log(`[registry] listening on :${PORT}`));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
