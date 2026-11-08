# Build từ thư mục gốc repo: docker build -f services/mock-service/Dockerfile .
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY packages/registry-client ./packages/registry-client
COPY services/mock-service ./services/mock-service
WORKDIR /app/services/mock-service
EXPOSE 3000
USER node
CMD ["node", "index.js"]
