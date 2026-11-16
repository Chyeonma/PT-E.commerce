FROM node:20-alpine
WORKDIR /app
COPY packages/registry-client ./packages/registry-client
COPY packages/file-store ./packages/file-store
COPY services/pricing ./services/pricing
EXPOSE 3000
CMD ["node", "services/pricing/index.js"]
