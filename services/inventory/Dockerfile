FROM node:20-alpine
WORKDIR /app
COPY packages/registry-client ./packages/registry-client
COPY packages/file-store ./packages/file-store
COPY services/inventory ./services/inventory
EXPOSE 3000
CMD ["node", "services/inventory/index.js"]
