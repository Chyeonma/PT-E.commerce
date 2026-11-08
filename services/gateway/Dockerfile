# Build từ thư mục gốc repo: docker build -f services/gateway/Dockerfile .
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY services/gateway ./services/gateway
WORKDIR /app/services/gateway
EXPOSE 8080
USER node
CMD ["node", "index.js"]
