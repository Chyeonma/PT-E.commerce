# Đề tài E: Nền tảng đơn hàng và tồn kho theo kiến trúc hướng dịch vụ (SOA)

**Tài liệu hỗ trợ:** [Kiến thức cần thiết và bảng tra cứu theo yêu cầu](KienThucNenTang.md#ban-do-yeu-cau) · [Sơ đồ mô phỏng hệ thống](SoDoHeThong.md).

<a id="tai-lieu-tham-chieu"></a>

## Liên hệ với giáo trình và đề cương môn học

- Giáo trình: [*Distributed Systems: Principles and Paradigms*, ấn bản 2 — Andrew S. Tanenbaum và Maarten van Steen](KienThucNenTang.md#nguon-va-pham-vi).
- Bài giảng 01, 11, 12.
- [Chương 2](KienThucNenTang.md#chuong-2) ([Mục 2.2.1](KienThucNenTang.md#tinh-luy-dang), [Hình 2-6](KienThucNenTang.md#kien-truc-ba-tang)), [Chương 10](KienThucNenTang.md#chuong-10) và [Chương 12](KienThucNenTang.md#chuong-12).

<a id="muc-tieu-he-thong"></a>

## Mục tiêu hệ thống

Xây dựng hệ thống backend thương mại điện tử [ba tầng](KienThucNenTang.md#kien-truc-ba-tang), có mức độ [liên kết lỏng](KienThucNenTang.md#kien-truc-va-lien-ket-long), sử dụng [dịch vụ web (SOAP/WSDL hoặc REST/gRPC)](KienThucNenTang.md#web-services-uddi-wsdl-soap), với các khả năng:

- [Khám phá dịch vụ động](KienThucNenTang.md#dang-ky-va-kham-pha-dich-vu).
- [Xử lý không lưu trạng thái (stateless) hoặc sử dụng trạng thái tạm thời (soft-state)](KienThucNenTang.md#stateless-va-soft-state).
- [Định tuyến thông điệp](KienThucNenTang.md#dinh-tuyen-va-round-robin).

## Phân công mô-đun cho từng sinh viên

<a id="sinh-vien-1"></a>

### Sinh viên 1 — Sổ đăng ký dịch vụ (UDDI-Lite) và API Gateway/bộ chuyển mạch

Triển khai một [dịch vụ danh bạ để các nút backend đăng ký địa chỉ truy cập (endpoint) khi khởi động](KienThucNenTang.md#dang-ky-va-kham-pha-dich-vu), kết hợp với một bộ chuyển mạch logic ở phía trước ([Hình 3-12](KienThucNenTang.md#dinh-tuyen-va-round-robin)). Bộ chuyển mạch này [định tuyến yêu cầu từ phía máy khách và cân bằng tải theo cơ chế luân phiên (round-robin)](KienThucNenTang.md#dinh-tuyen-va-round-robin).

1. Người 1 phụ trách Registry và API Gateway — giúp các dịch vụ tìm và gọi được nhau.
   - Xây dựng Registry để lưu tên dịch vụ, mã bản sao và endpoint.
   - Cung cấp API đăng ký, tra cứu và cập nhật danh sách backend.
   - Xây dựng cơ chế để backend tự đăng ký khi khởi động và loại bỏ endpoint không còn hoạt động.
   - Xây dựng Gateway để tiếp nhận yêu cầu, xác định đúng dịch vụ rồi chuyển tiếp đến backend.
   - Cân bằng tải round-robin giữa các bản sao của cùng dịch vụ.
 Minh chứng hoàn thành: khởi động thêm một bản sao Inventory, bản sao xuất hiện trong Registry và bắt đầu nhận yêu cầu qua Gateway.


<a id="sinh-vien-2"></a>

### Sinh viên 2 — Các dịch vụ tồn kho và định giá

Triển khai các dịch vụ backend [được nhân bản](KienThucNenTang.md#nhan-ban-backend), [stateless](KienThucNenTang.md#stateless-va-soft-state), cùng với bộ nhớ đệm giữ hàng tạm thời theo cơ chế soft-state. Bộ nhớ đệm [giữ lại số lượng hàng trong kho trong một khoảng thời gian sống (TTL) giới hạn; khi hết TTL, trạng thái giữ hàng tự động hết hiệu lực](KienThucNenTang.md#giu-hang-theo-ttl) ([Mục 3.4.1](KienThucNenTang.md#stateless-va-soft-state)).

2. Người 2 phụ trách Inventory và Pricing — quản lý giá, số lượng và giữ hàng.
   - Xây dựng dịch vụ lấy giá sản phẩm: GetPrice.
   - Xây dựng các thao tác tồn kho: GetStock, ReserveStock, ConfirmReservation, ReleaseReservation.
   - Tạo bản ghi giữ hàng gồm mã giữ hàng, đơn hàng, sản phẩm, số lượng và thời điểm hết hạn.
   - Xử lý TTL: giữ hàng trong thời hạn; hết hạn hoặc hủy thì giải phóng; xác nhận thành công thì ghi nhận hàng đã bán.
   - Kiểm soát yêu cầu đồng thời để tránh giữ hoặc bán vượt tồn kho.
   - Chạy nhiều bản sao backend stateless, bảo đảm các bản sao sử dụng trạng thái tồn kho và giữ hàng nhất quán.
   - Tích hợp việc tự đăng ký với Registry do người 1 cung cấp.

   Minh chứng hoàn thành: hai yêu cầu cùng tranh mua sản phẩm cuối cùng chỉ có một yêu cầu giữ được hàng; giữ hàng hết hạn thì lượng hàng được giải phóng đúng.


<a id="sinh-vien-3"></a>

### Sinh viên 3 — Bộ điều phối đơn hàng và dịch vụ thanh toán có tính lũy đẳng

Triển khai tầng xử lý trung gian ([Hình 2-6](KienThucNenTang.md#kien-truc-ba-tang)), [thực hiện chuỗi lời gọi tới các dịch vụ tồn kho và thanh toán](KienThucNenTang.md#dieu-phoi-don-hang). Bảo đảm các [thao tác có tính lũy đẳng](KienThucNenTang.md#thanh-toan-luy-dang) (idempotent, [Mục 2.2.1](KienThucNenTang.md#tinh-luy-dang)), để việc gửi lại yêu cầu do sự cố mạng không bao giờ khiến khách hàng bị tính tiền hai lần.

3. Người 3 phụ trách Order Orchestrator và Payment — hoàn thành quy trình đặt hàng và chống thanh toán lặp.
   - Xây dựng API tạo và xem trạng thái đơn hàng: CreateOrder, GetOrder.
   - Điều phối luồng: lấy giá → giữ hàng → thanh toán → xác nhận hàng → hoàn tất đơn.
   - Xây dựng dịch vụ thanh toán ChargePayment.
   - Dùng mã chống lặp ổn định cho mỗi lần thanh toán logic; lưu trạng thái và kết quả để xử lý yêu cầu gửi lại.
   - Bảo đảm các yêu cầu trùng đến đồng thời hoặc đến bản sao khác vẫn chỉ tạo một lần tính tiền.
   - Theo dõi và xử lý các nhánh lỗi: hết hàng, thanh toán thất bại, mất phản hồi, giữ hàng hết hạn hoặc đã thanh toán nhưng chưa xác nhận được hàng.
   - Tích hợp Registry/Gateway của người 1 và các API của người 2.

   Minh chứng hoàn thành: gửi lại cùng yêu cầu thanh toán sau khi mất phản hồi vẫn trả về kết quả phù hợp và chỉ ghi nhận một lần tính tiền.

Phần cả nhóm cần thống nhất trước: hợp đồng API, tên dịch vụ, định danh đơn hàng/giữ hàng/thanh toán, cấu trúc lỗi và trạng thái nghiệp vụ. Khi tích hợp, cả nhóm kiểm chứng một luồng đặt hàng hoàn chỉnh cùng các tình huống lỗi kể trên.
