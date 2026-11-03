# Sơ đồ kiến trúc tổng thể nền tảng đơn hàng và tồn kho

Tài liệu liên quan: [Đề tài và phân công](DeTai.md) · [Kiến thức nền tảng](KienThucNenTang.md).

<a id="kien-truc"></a>

Đọc luồng đặt hàng từ trên xuống dưới, theo các bước **1–6**. Mỗi khung nét liền là một chương trình; khung lớn nét đứt nhóm các thành phần liên quan. Inventory và Pricing có thể chạy nhiều bản sao từ cùng chương trình.

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"background": "#0d1117", "textColor": "#e6edf3", "lineColor": "#94a3b8", "edgeLabelBackground": "#0d1117", "clusterBkg": "#111820", "clusterBorder": "#556273", "titleColor": "#e6edf3"}}}%%
flowchart TB
    CLIENT(["Client / công cụ gửi request"])

    subgraph INFRA["Hạ tầng truy cập · Người 1"]
        direction TB
        GATEWAY["API Gateway / Load Balancer<br/>Nhận request, tra cứu dịch vụ,<br/>chọn bản sao và chuyển tiếp"]
        REGISTRY["Service Registry<br/>Tên dịch vụ, mã bản sao và endpoint"]
    end

    ORDER["Order Orchestrator · Người 3<br/>Điều phối các bước đặt hàng<br/>và theo dõi trạng thái đơn"]

    subgraph DOMAIN["Các dịch vụ nghiệp vụ"]
        direction TB
        subgraph STOCK_PRICE["Kho và định giá · Người 2"]
            direction TB
            PRICING["Pricing Service<br/>Cung cấp giá sản phẩm"]
            INVENTORY["Inventory Service<br/>Giữ hàng có TTL,<br/>xác nhận và giải phóng hàng"]
        end
        PAYMENT["Payment Service · Người 3<br/>Thanh toán và chống xử lý lặp"]
    end

    CLIENT -->|"1. Gửi yêu cầu đặt hàng"| GATEWAY
    GATEWAY -->|"2. Chuyển yêu cầu"| ORDER
    ORDER -->|"3–6. Gọi dịch vụ theo route"| GATEWAY
    GATEWAY -->|"3. Lấy giá"| PRICING
    GATEWAY -->|"4. Giữ hàng / 6. Xác nhận"| INVENTORY
    GATEWAY -->|"5. Thanh toán"| PAYMENT

    REGISTRY <-.->|"Tra cứu / danh sách endpoint"| GATEWAY
    REGISTRY <-.->|"Đăng ký / xác nhận đăng ký"| ORDER
    REGISTRY <-.->|"Đăng ký / xác nhận đăng ký"| DOMAIN
    %% Lien ket an chi dung de sap xep bo cuc.
    ORDER ~~~ DOMAIN
    CLIENT ~~~ REGISTRY

    classDef client fill:#1e293b,stroke:#7d8a9a,stroke-width:1.5px,color:#e6edf3
    classDef person1 fill:#15283e,stroke:#7b9fc5,stroke-width:2px,color:#e6edf3
    classDef person2 fill:#163128,stroke:#6b9d86,stroke-width:2px,color:#e6edf3
    classDef person3 fill:#2b233c,stroke:#a68ac0,stroke-width:2px,color:#e6edf3
    class CLIENT client
    class GATEWAY,REGISTRY person1
    class PRICING,INVENTORY person2
    class ORDER,PAYMENT person3
    style INFRA fill:#111c2c,stroke:#516c8b,stroke-width:1px,stroke-dasharray:5 5,color:#e6edf3
    style DOMAIN fill:#111820,stroke:#556273,stroke-width:1px,stroke-dasharray:5 5,color:#e6edf3
    style STOCK_PRICE fill:#11241d,stroke:#52775f,stroke-width:1px,stroke-dasharray:5 5,color:#e6edf3
    linkStyle 0,1,2,3,4,5 stroke:#94a3b8,stroke-width:2px,color:#cbd5e1
    linkStyle 6,7,8 stroke:#718096,stroke-width:1.25px,color:#b8c2cf
```

- **Khối hạ tầng màu xanh dương:** Registry và Gateway do người 1 phụ trách.
- **Khối kho và định giá màu xanh lá:** Pricing và Inventory do người 2 phụ trách; đặt cạnh nhau theo thứ tự lấy giá rồi giữ hàng.
- **Các chương trình màu tím:** Order Orchestrator và Payment do người 3 phụ trách.
- **Đường liền đậm:** luồng request chính; phản hồi đi ngược chiều tương tác.
- **Đường nét đứt màu xám:** đăng ký/xác nhận đăng ký và tra cứu endpoint với Registry. Đường nối vào khối dịch vụ áp dụng cho từng chương trình bên trong khối.

**Thứ tự nghiệp vụ:** 1. Client gửi yêu cầu → 2. Gateway chuyển đến Order → 3. Lấy giá → 4. Giữ hàng → 5. Thanh toán → 6. Xác nhận hàng. Sau khi các bước thành công, Order hoàn tất đơn và trả kết quả qua Gateway.

Các bước 3–6 do Order quyết định và gửi qua cùng một Gateway. Gateway xác định dịch vụ đích theo route và chọn bản sao bằng round-robin. Việc đăng ký dịch vụ diễn ra khi khởi động; thông tin endpoint được Gateway tra cứu và làm mới theo chính sách của hệ thống.
