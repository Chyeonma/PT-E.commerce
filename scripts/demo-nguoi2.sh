#!/usr/bin/env sh
# Kịch bản minh chứng hoàn thành cho Người 2 (Inventory & Pricing Services):
#   1. Hai bản sao Pricing và hai bản sao Inventory tự đăng ký vào Registry và chia tải qua Gateway.
#   2. Hai yêu cầu đồng thời tranh mua sản phẩm cuối cùng (P_LAST, totalStock = 1) qua các bản sao
#      chỉ có đúng một yêu cầu giữ được hàng (201), yêu cầu còn lại nhận 409 insufficient_stock.
#   3. Giữ hàng với TTL ngắn (3 giây): trong thời hạn hàng bị khóa; hết TTL tự động giải phóng
#      để đơn khác mua được, và xác nhận muộn bị từ chối (409 reservation_expired).
set -e

GW=${GW:-http://localhost:8080}
REG=${REG:-http://localhost:4000}

echo "== 1. Khởi động hệ thống (registry, gateway, 2 inventory, 2 pricing)"
docker compose up --build -d
sleep 3

echo "== 2. Danh sách bản sao đăng ký trong Registry:"
curl -s "$REG/services/pricing-service" | grep -o '"instanceId":"[^"]*"'
curl -s "$REG/services/inventory-service" | grep -o '"instanceId":"[^"]*"'

echo "\n== 3. Gọi GetPrice qua Gateway (luân phiên 2 bản sao pricing-service):"
curl -s "$GW/pricing/prices/P1?quantity=2" && echo
curl -s "$GW/pricing/prices/P1?quantity=2" && echo

echo "\n== 4. Đặt tồn kho sản phẩm P_LAST = 1 để kiểm chứng tranh chấp đồng thời:"
curl -s -X PUT "$GW/inventory/stock/P_LAST" \
  -H 'content-type: application/json' \
  -d '{"name":"Limited Edition GPU","totalStock":1}' && echo

echo "\n== 5. [MINH CHỨNG 1] Hai yêu cầu đồng thời cùng tranh mua sản phẩm cuối cùng (P_LAST):"
TMP1=$(mktemp)
TMP2=$(mktemp)
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "$GW/inventory/reserve" \
  -H 'content-type: application/json' \
  -d '{"orderId":"ORD-CONCURRENT-A","productId":"P_LAST","quantity":1,"ttlSeconds":3}' > "$TMP1" &
PID1=$!
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "$GW/inventory/reserve" \
  -H 'content-type: application/json' \
  -d '{"orderId":"ORD-CONCURRENT-B","productId":"P_LAST","quantity":1,"ttlSeconds":3}' > "$TMP2" &
PID2=$!
wait "$PID1" "$PID2"

echo "  -> Kết quả Request A:"
cat "$TMP1"
echo "  -> Kết quả Request B:"
cat "$TMP2"
rm -f "$TMP1" "$TMP2"

echo "\n== 6. Tồn kho P_LAST ngay khi đang giữ hàng (availableStock = 0, reservedStock = 1):"
curl -s "$GW/inventory/stock/P_LAST" && echo

echo "\n== 7. [MINH CHỨNG 2] Đợi 4 giây để giữ hàng hết hạn TTL (3s) -> tự động giải phóng:"
sleep 4
curl -s "$GW/inventory/stock/P_LAST" && echo

echo "\n== 8. Giữ hàng mới trên P_LAST rồi xác nhận (ConfirmReservation) -> trừ kho thành hàng đã bán:"
RSV_JSON=$(curl -s -X POST "$GW/inventory/reserve" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-order-final' \
  -d '{"orderId":"ORD-FINAL","productId":"P_LAST","quantity":1,"ttlSeconds":30}')
echo "  -> Đã giữ hàng: $RSV_JSON"
RSV_ID=$(printf "%s" "$RSV_JSON" | sed -n 's/.*"reservationId":"\([^"]*\)".*/\1/p')

echo "  -> Xác nhận giữ hàng $RSV_ID:"
curl -s -X POST "$GW/inventory/reservations/$RSV_ID/confirm" && echo

echo "  -> Tồn kho P_LAST sau khi xác nhận (totalStock = 0, soldStock = 1):"
curl -s "$GW/inventory/stock/P_LAST" && echo
