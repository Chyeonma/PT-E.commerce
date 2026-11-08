#!/usr/bin/env sh
# Demo minh chứng cho Người 1: bản sao Inventory mới xuất hiện trong Registry
# và bắt đầu nhận request qua Gateway (round-robin).
# Yêu cầu: docker compose, curl.
set -e
GW=${GW:-http://localhost:8080}
REG=${REG:-http://localhost:4000}

show_rr() {
  i=1
  while [ $i -le $1 ]; do
    curl -s "$GW/inventory/stock/P1" | sed -n 's/.*"instanceId":"\([^"]*\)".*/  -> \1/p'; echo
    i=$((i + 1))
  done
}

echo "== 1. Khởi động hệ thống (registry, gateway, 2 inventory, 2 pricing)"
docker compose up --build -d
sleep 3

echo "== 2. Registry hiện có:"
curl -s "$REG/services/inventory-service" | grep -o '"instanceId":"[^"]*"'

echo "== 3. Gọi Gateway 4 lần -> luân phiên 2 bản sao:"
show_rr 4

echo "== 4. Thêm bản sao Inventory thứ 3"
docker compose up -d --scale inventory-service=3 --no-recreate
sleep 3
curl -s "$REG/services/inventory-service" | grep -o '"instanceId":"[^"]*"'

echo "== 5. Gọi Gateway 6 lần -> luân phiên 3 bản sao:"
show_rr 6

echo "== 6. POST có Idempotency-Key (được chuyển tiếp tới backend):"
curl -s -X POST "$GW/inventory/reserve" -H 'content-type: application/json' \
  -H 'Idempotency-Key: order-123-reserve' -d '{"productId":"P1","quantity":1}'
echo

echo "== 7. Giảm về 2 bản sao: bản sao bị tắt tự hủy đăng ký"
docker compose up -d --scale inventory-service=2 --no-recreate
sleep 2
curl -s "$REG/services/inventory-service" | grep -o '"instanceId":"[^"]*"'
