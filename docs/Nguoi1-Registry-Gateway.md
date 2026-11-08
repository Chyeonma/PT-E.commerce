# Người 1 — Service Registry (UDDI-Lite) và API Gateway

Hiện thực phần "Hạ tầng truy cập" trong [sơ đồ hệ thống](chu%20de/SoDoHeThong.md): Registry giúp các dịch vụ tìm thấy nhau, Gateway nhận request, chọn đúng dịch vụ và chia tải round-robin giữa các bản sao.

Viết bằng Node.js (>= 18), **không dùng thư viện ngoài** (chỉ `http` và `fetch` có sẵn), chạy bằng Docker Compose.

## Cấu trúc thư mục

| Đường dẫn | Nội dung |
|---|---|
| `services/registry/` | Service Registry, lưu trong bộ nhớ, cổng 4000 |
| `services/gateway/` | API Gateway, cổng 8080; bảng route ở `routes.json` |
| `packages/registry-client/` | Thư viện để backend tự đăng ký, gửi heartbeat và hủy đăng ký (người 2, 3 dùng lại) |
| `services/mock-service/` | Backend giả lập để demo khi chưa có module của người 2, 3 |
| `tests/` | Kiểm thử tự động (`npm test`) |
| `scripts/demo.sh` | Kịch bản demo minh chứng |
| `docker-compose.yml` | registry + gateway + 2 bản sao inventory + 2 bản sao pricing (mock) |

## Chạy nhanh

```bash
docker compose up --build -d                       # khởi động
curl http://localhost:4000/services                # xem danh bạ
curl -i http://localhost:8080/inventory/stock/P1   # gọi qua gateway, xem header X-Served-By
docker compose up -d --scale inventory-service=3   # thêm bản sao Inventory
./scripts/demo.sh                                  # chạy toàn bộ kịch bản minh chứng
docker compose down
```

Chạy không cần Docker (3 terminal):

```bash
npm run start:registry
REGISTRY_URL=http://localhost:4000 npm run start:gateway
SERVICE_NAME=inventory-service PORT=3001 ADVERTISE_HOST=127.0.0.1 npm run start:mock
```

Kiểm thử: `npm test` (8 test: đăng ký, TTL, round-robin, thêm bản sao, retry, Idempotency-Key, cách ly bản sao lỗi).

## Service Registry — API

Mỗi bản ghi gồm: `serviceName`, `instanceId` (mã bản sao), `endpoint`, `metadata`, `ttlSeconds`, `registeredAt`, `lastHeartbeat`, `expiresAt`.

| Method | Đường dẫn | Ý nghĩa |
|---|---|---|
| `POST` | `/services/register` | Đăng ký (hoặc đăng ký lại). Body: `{ serviceName, instanceId?, host, port }` hoặc `{ serviceName, endpoint }`, tùy chọn `ttlSeconds` (mặc định 10, tối đa 300), `metadata`. Trả `201` kèm bản ghi. |
| `PUT` | `/services/:name/instances/:id/heartbeat` | Gia hạn TTL. `404` nếu registry không còn bản ghi, khi đó client đăng ký lại. |
| `DELETE` | `/services/:name/instances/:id` | Hủy đăng ký khi tắt. |
| `GET` | `/services/:name` | Danh sách endpoint còn sống: `{ serviceName, instances: [...] }`. |
| `GET` | `/services` | Toàn bộ danh bạ. |
| `GET` | `/health` | Kiểm tra sống. |

**Chính sách loại bỏ endpoint (soft-state):** backend phải gửi heartbeat trước khi hết TTL. Registry quét mỗi giây và xóa bản ghi quá hạn, nên bản sao bị tắt đột ngột (crash, `kill -9`) tự biến mất sau tối đa TTL giây. Bản sao tắt bình thường (SIGTERM) hủy đăng ký ngay.

## API Gateway

**Định tuyến 2 bước** (Mục 3.4.2, Hình 3-12):

1. Xác định dịch vụ theo tiền tố đường dẫn (khớp tiền tố dài nhất), cấu hình ở `services/gateway/routes.json`:

   | Tiền tố | Dịch vụ trong registry |
   |---|---|
   | `/orders` | `order-service` |
   | `/inventory` | `inventory-service` |
   | `/pricing` | `pricing-service` |
   | `/payments` | `payment-service` |

   Mặc định gateway chuyển **nguyên đường dẫn** (`/inventory/stock/P1` → backend nhận `/inventory/stock/P1`). Đặt `"stripPrefix": true` nếu muốn backend nhận `/stock/P1`.
2. Tra cứu registry (lưu đệm 2 giây), chọn bản sao bằng **round-robin** riêng cho từng dịch vụ.

**Xử lý lỗi và thử lại:**

- Khi bản sao không kết nối được hoặc quá thời gian chờ, gateway thử bản sao kế tiếp, nhưng chỉ với request an toàn để gửi lại: method lũy đẳng (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`) hoặc request có header `Idempotency-Key`. `POST` không có `Idempotency-Key` sẽ **không** bị gửi lại, để tránh tác dụng nghiệp vụ lặp như trừ tiền hai lần (Mục 2.2.1).
- Header `Idempotency-Key` luôn được chuyển nguyên vẹn tới backend; Payment/Order (người 3) dùng nó để chống xử lý lặp.
- Bản sao vừa lỗi bị cách ly 5 giây (`QUARANTINE_MS`), nên các request sau không phải chờ timeout lại trong lúc registry chưa hết TTL của nó.
- Không có bản sao nào: `503 no_available_instance`. Mọi bản sao lỗi: `502 upstream_unavailable`. Không khớp route: `404 route_not_found`.

**Header gateway thêm vào:**

- Gửi tới backend: `X-Request-Id`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Prefix`.
- Trả về client: `X-Served-By` (instanceId đã xử lý), `X-Gateway-Service`, `X-Gateway-Attempts`, `X-Request-Id`.

Endpoint nội bộ: `GET /health`, `GET /gateway/routes` (route và các bản sao hiện có).

**Biến môi trường:** `PORT` (8080), `REGISTRY_URL`, `REGISTRY_CACHE_TTL_MS` (2000), `UPSTREAM_TIMEOUT_MS` (5000), `QUARANTINE_MS` (5000), `ROUTES_FILE`.

## Hướng dẫn tích hợp cho người 2 và người 3

Với service Node.js, chỉ cần thêm vào lúc khởi động:

```js
const { RegistryClient } = require('../../packages/registry-client');

server.listen(PORT, () => {
  new RegistryClient({
    registryUrl: process.env.REGISTRY_URL,   // http://registry:4000 trong docker compose
    serviceName: 'inventory-service',        // đúng tên trong routes.json
    port: PORT,
  }).start();                                // đăng ký, heartbeat, tự hủy đăng ký khi SIGTERM
});
```

- Đường dẫn API của service nên bắt đầu bằng tiền tố route (vd. Inventory phục vụ `/inventory/...`).
- Order gọi Inventory, Pricing, Payment **qua gateway** (`http://gateway:8080/pricing/...`), không gọi thẳng bản sao.
- Ngôn ngữ khác: gọi trực tiếp REST API của registry ở trên (register khi khởi động, heartbeat mỗi khoảng TTL/3 giây, delete khi tắt).
- Trong `docker-compose.yml`, không đặt `container_name` và không publish cổng cho backend, để `--scale` hoạt động.

## Minh chứng hoàn thành

> Khởi động thêm một bản sao Inventory, bản sao xuất hiện trong Registry và bắt đầu nhận yêu cầu qua Gateway.

`./scripts/demo.sh` thực hiện đúng kịch bản này: 2 bản sao luân phiên → `--scale inventory-service=3` → registry có 3 bản ghi → 6 request luân phiên đều qua 3 bản sao → giảm về 2 thì bản sao bị tắt tự hủy đăng ký. Thêm tình huống crash: `docker kill -s KILL <container>` → gateway thử bản sao kế tiếp (client vẫn nhận 200) → sau 10 giây registry ghi log `expired`.
