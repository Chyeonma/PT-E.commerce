# Đề tài E: Nền tảng đơn hàng và tồn kho theo kiến trúc hướng dịch vụ (SOA)

**Tài liệu hỗ trợ:** [Kiến thức cần thiết và bảng tra cứu theo yêu cầu](kien-thuc-nen-tang-de-tai-e.md#ban-do-yeu-cau).

<a id="tai-lieu-tham-chieu"></a>

## Liên hệ với giáo trình và đề cương môn học

- Giáo trình: [*Distributed Systems: Principles and Paradigms*, ấn bản 2 — Andrew S. Tanenbaum và Maarten van Steen](kien-thuc-nen-tang-de-tai-e.md#nguon-va-pham-vi).
- Bài giảng 01, 11, 12.
- [Chương 2](kien-thuc-nen-tang-de-tai-e.md#chuong-2) ([Mục 2.2.1](kien-thuc-nen-tang-de-tai-e.md#tinh-luy-dang), [Hình 2-6](kien-thuc-nen-tang-de-tai-e.md#kien-truc-ba-tang)), [Chương 10](kien-thuc-nen-tang-de-tai-e.md#chuong-10) và [Chương 12](kien-thuc-nen-tang-de-tai-e.md#chuong-12).

<a id="muc-tieu-he-thong"></a>

## Mục tiêu hệ thống

Xây dựng hệ thống backend thương mại điện tử [ba tầng](kien-thuc-nen-tang-de-tai-e.md#kien-truc-ba-tang), có mức độ [liên kết lỏng](kien-thuc-nen-tang-de-tai-e.md#kien-truc-va-lien-ket-long), sử dụng [dịch vụ web (SOAP/WSDL hoặc REST/gRPC)](kien-thuc-nen-tang-de-tai-e.md#web-services-uddi-wsdl-soap), với các khả năng:

- [Khám phá dịch vụ động](kien-thuc-nen-tang-de-tai-e.md#dang-ky-va-kham-pha-dich-vu).
- [Xử lý không lưu trạng thái (stateless) hoặc sử dụng trạng thái tạm thời (soft-state)](kien-thuc-nen-tang-de-tai-e.md#stateless-va-soft-state).
- [Định tuyến thông điệp](kien-thuc-nen-tang-de-tai-e.md#dinh-tuyen-va-round-robin).

## Phân công mô-đun cho từng sinh viên

<a id="sinh-vien-1"></a>

### Sinh viên 1 — Sổ đăng ký dịch vụ (UDDI-Lite) và API Gateway/bộ chuyển mạch

Triển khai một [dịch vụ danh bạ để các nút backend đăng ký địa chỉ truy cập (endpoint) khi khởi động](kien-thuc-nen-tang-de-tai-e.md#dang-ky-va-kham-pha-dich-vu), kết hợp với một bộ chuyển mạch logic ở phía trước ([Hình 3-12](kien-thuc-nen-tang-de-tai-e.md#dinh-tuyen-va-round-robin)). Bộ chuyển mạch này [định tuyến yêu cầu từ phía máy khách và cân bằng tải theo cơ chế luân phiên (round-robin)](kien-thuc-nen-tang-de-tai-e.md#dinh-tuyen-va-round-robin).

<a id="sinh-vien-2"></a>

### Sinh viên 2 — Các dịch vụ tồn kho và định giá

Triển khai các dịch vụ backend [được nhân bản](kien-thuc-nen-tang-de-tai-e.md#nhan-ban-backend), [không lưu trạng thái](kien-thuc-nen-tang-de-tai-e.md#stateless-va-soft-state), cùng với bộ nhớ đệm giữ hàng tạm thời theo cơ chế soft-state. Bộ nhớ đệm [giữ lại số lượng hàng trong kho trong một khoảng thời gian sống (TTL) giới hạn; khi hết TTL, trạng thái giữ hàng tự động hết hiệu lực](kien-thuc-nen-tang-de-tai-e.md#giu-hang-theo-ttl) ([Mục 3.4.1](kien-thuc-nen-tang-de-tai-e.md#stateless-va-soft-state)).

<a id="sinh-vien-3"></a>

### Sinh viên 3 — Bộ điều phối đơn hàng và dịch vụ thanh toán có tính lũy đẳng

Triển khai tầng xử lý trung gian ([Hình 2-6](kien-thuc-nen-tang-de-tai-e.md#kien-truc-ba-tang)), [thực hiện chuỗi lời gọi tới các dịch vụ tồn kho và thanh toán](kien-thuc-nen-tang-de-tai-e.md#dieu-phoi-don-hang). Bảo đảm các [thao tác có tính lũy đẳng](kien-thuc-nen-tang-de-tai-e.md#thanh-toan-luy-dang) (idempotent, [Mục 2.2.1](kien-thuc-nen-tang-de-tai-e.md#tinh-luy-dang)), để việc gửi lại yêu cầu do sự cố mạng không bao giờ khiến khách hàng bị tính tiền hai lần.
