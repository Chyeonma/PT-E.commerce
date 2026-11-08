# Build từ thư mục gốc repo: docker build -f services/registry/Dockerfile .
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY services/registry ./services/registry
WORKDIR /app/services/registry
EXPOSE 4000
USER node
CMD ["node", "index.js"]
