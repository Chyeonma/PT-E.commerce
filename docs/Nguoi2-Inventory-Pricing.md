# Người 2 — Dịch vụ Tồn kho (Inventory) và Định giá (Pricing)

Hiện thực khối **"Kho và định giá · Người 2"** trong [sơ đồ hệ thống](chu%20de/SoDoHeThong.md) và [phân công đề tài](chu%20de/DeTai.md#sinh-vien-2):

- Triển khai các dịch vụ backend **được nhân bản (replicated)**, **không lưu trạng thái phiên (stateless)**.
- Xây dựng bộ nhớ đệm giữ hàng tạm thời theo cơ chế **soft-state reservation cache** có thời gian sống (**TTL**, Mục 3.4.1): trong thời hạn thì khóa lượng hàng; khi hết TTL thì tự động hết hiệu lực và giải phóng tồn kho.
- Đảm bảo **tính nhất quán dữ liệu và kiểm soát đồng thời** giữa nhiều bản sao stateless thông qua kho trạng thái dùng chung (`packages/file-store`) trên Docker Shared Volume kết hợp cơ chế khóa nguyên tử (`Atomic Lockdir` + `Atomic Write`).
- Viết bằng Node.js (>= 18), **không dùng thư viện ngoài**, tích hợp sẵn `RegistryClient` của Người 1.

---

## 1. Cấu trúc thư mục phần Người 2

| Đường dẫn | Nội dung |
|---|---|
| `packages/file-store/` | Kho lưu trữ JSON dùng chung giữa các bản sao với khóa độc quyền liên tiến trình (`fs.mkdirSync` lockdir) và ghi nguyên tử (`tmp` + `rename`) |
| `services/pricing/` | **Pricing Service** (`pricing-service`): tra cứu giá, báo giá theo số lượng/danh sách, cập nhật giá |
| `services/inventory/` | **Inventory Service** (`inventory-service`): quản lý tồn kho, giữ hàng có TTL (`ReserveStock`), xác nhận (`ConfirmReservation`), hủy giữ hàng (`ReleaseReservation`) |
| `tests/inventory-pricing.test.js` | Bộ kiểm thử tự động cho `FileStore`, `PricingService`, `InventoryService`, tranh chấp đồng thời và hết hạn TTL |
| `scripts/demo-nguoi2.sh` | Kịch bản demo 2 minh chứng hoàn thành của Người 2 qua Docker Compose & Gateway |

---

## 2. Cơ chế đồng bộ trạng thái giữa các bản sao Stateless

Theo **Hình 3-12** trong giáo trình, khi API Gateway phân tải **Round-Robin** giữa nhiều bản sao `inventory-service` (`replicas: 2+`):

1. Bản sao xử lý không giữ trạng thái tồn kho trong RAM riêng mà đọc/ghi qua `FileStore` (`INVENTORY_DATA_FILE=/data/inventory.json` được mount từ volume chung `shared-data`).
2. Mỗi thao tác thay đổi hoặc đọc tồn kho đều đi qua `fileStore.transact(mutator)`:
   - Chiếm khóa nguyên tử ở tầng hệ điều hành bằng `fs.mkdirSync('/data/inventory.json.lock')` (nếu một tiến trình bị crash khi đang giữ khóa, khóa quá hạn `staleLockMs` sẽ tự được thu hồi).
   - Quét và giải phóng ngay các bản ghi `RESERVED` đã quá hạn (`expiresAt <= now` $\rightarrow$ `EXPIRED`).
   - Kiểm tra điều kiện nghiệp vụ (`availableStock = totalStock - reservedStock >= quantity`).
   - Ghi ra file tạm và đổi tên nguyên tử (`fs.renameSync`) trước khi nhả khóa.

Nhờ vậy:
- Bước 4 (`ReserveStock`) rơi vào **Bản sao 1** và bước 6 (`ConfirmReservation`) rơi vào **Bản sao 2** vẫn nhìn thấy cùng một bản ghi giữ hàng.
- Hai yêu cầu cùng tranh mua sản phẩm cuối cùng trên 2 bản sao khác nhau được tuần tự hóa an toàn, tuyệt đối không xảy ra bán lố (overselling).

---

## 3. Hợp đồng API (Dành cho Người 3 — Order Orchestrator)

Tất cả các API đều gọi qua **API Gateway** (`http://gateway:8080/...` trong Docker hoặc `http://localhost:8080/...` từ máy host).

### 3.1. Pricing Service (`/pricing`)

| Method | Đường dẫn | Mô tả & Dữ liệu |
|---|---|---|
| `GET` | `/pricing/prices` | Danh sách toàn bộ sản phẩm kèm giá: `{ products: [...] }` |
| `GET` | `/pricing/prices/:productId?quantity=N` | **GetPrice**: trả về `{ productId, name, unitPrice, currency, quantity, totalPrice, instanceId }`. (Hỗ trợ cả đường dẫn rút gọn `GET /pricing/:productId`). |
| `POST` | `/pricing/quote` | Tính giá cho 1 mặt hàng (`{ productId, quantity }`) hoặc giỏ hàng (`{ items: [{ productId, quantity }] }`). |
| `PUT` | `/pricing/prices/:productId` | Cập nhật hoặc thêm mới giá sản phẩm: `{ name?, unitPrice, currency? }`. |

### 3.2. Inventory Service (`/inventory`)

| Method | Đường dẫn | Mô tả & Dữ liệu |
|---|---|---|
| `GET` | `/inventory/stock` | Danh sách tồn kho của tất cả sản phẩm. |
| `GET` | `/inventory/stock/:productId` | **GetStock**: trả về `{ productId, name, totalStock, reservedStock, availableStock, soldStock, instanceId }`. |
| `PUT` | `/inventory/stock/:productId` | Đặt lại tồn kho cho sản phẩm: `{ name?, totalStock }`. |
| `POST` | `/inventory/reserve` | **ReserveStock**: tạo bản ghi giữ hàng theo TTL.<br>- Header tùy chọn: `Idempotency-Key: <key>` (để retry an toàn qua Gateway).<br>- Body: `{ orderId, productId, quantity, ttlSeconds? }` (mặc định `ttlSeconds = 30`).<br>- Thành công: `201` (hoặc `200` nếu lặp lại cùng `Idempotency-Key`) kèm `{ reservationId, orderId, productId, quantity, status: "RESERVED", expiresAt, stock }`.<br>- Hết hàng: `409 { error: "insufficient_stock", availableStock, requested }`. |
| `POST` | `/inventory/reservations/:id/confirm` | **ConfirmReservation**: xác nhận giữ hàng khi thanh toán thành công (hỗ trợ cả `POST /inventory/confirm` với body `{ reservationId }`).<br>- Nếu còn hạn TTL: trừ `totalStock`, tăng `soldStock`, chuyển trạng thái sang `"CONFIRMED"` (`200`). Gọi lặp lại trên bản ghi đã `"CONFIRMED"` vẫn trả `200` (lũy đẳng).<br>- Nếu đã quá hạn TTL: trả `409 { error: "reservation_expired" }`. |
| `POST` | `/inventory/reservations/:id/release` | **ReleaseReservation**: hủy giữ hàng khi thanh toán thất bại để giải phóng `availableStock` ngay (hỗ trợ cả `POST /inventory/release` hoặc `DELETE /inventory/reservations/:id`).<br>- Gọi lặp lại vẫn trả `200` (lũy đẳng).<br>- Nếu đơn đã `"CONFIRMED"`: trả `409 { error: "reservation_already_confirmed" }`. |
| `GET` | `/inventory/reservations/:id` | Xem chi tiết bản ghi giữ hàng. |
| `GET` | `/inventory/reservations` | Lọc danh sách giữ hàng theo `?orderId=...&productId=...&status=...`. |

---

## 4. Chạy nhanh & Kiểm thử

### Chạy kiểm thử tự động
```bash
npm test
# hoặc chạy riêng bộ test của Người 2:
node --test tests/inventory-pricing.test.js
```

### Chạy bằng Docker Compose & Kịch bản minh chứng
```bash
./scripts/demo-nguoi2.sh
```

Kịch bản `./scripts/demo-nguoi2.sh` tự động kiểm chứng cả 2 yêu cầu minh chứng trong đề bài:
1. **Tranh chấp đồng thời trên sản phẩm cuối cùng (`P_LAST`, `totalStock = 1`):** Bắn 2 request `POST /inventory/reserve` song song qua Gateway tới các bản sao `inventory-service` $\rightarrow$ chỉ 1 request nhận `201 Created`, request kia nhận `409 insufficient_stock`.
2. **Tự động giải phóng hàng khi hết TTL (`ttlSeconds = 3`):** Ngay sau khi giữ, `availableStock = 0`; sau 4 giây không xác nhận, bản ghi tự chuyển sang `EXPIRED` và `availableStock` tự quay về `1` để đơn hàng mới giữ và `confirm` thành công.
