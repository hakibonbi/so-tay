# Sổ tay học tập — gói triển khai gọn

## Bộ file cần đưa lên GitHub

- `index.html` — chứa toàn bộ giao diện: HTML, CSS và JavaScript, gồm các phần nâng cấp.
- `netlify/functions/presence.mjs` — API server dùng cho chat, kho MP3, bảng xếp hạng và các API có sẵn. Đây là file backend duy nhất.
- `netlify.toml` — khai báo thư mục web, Netlify Function và Node.js.
- `package.json`, `package-lock.json` — phụ thuộc `@netlify/blobs` để lưu dữ liệu dùng chung.
- `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png` — giữ chức năng cài ứng dụng/PWA và ngoại tuyến.
- `.gitignore` — bỏ qua `node_modules`, `.netlify` và tệp môi trường bí mật. `README_VI.md` chỉ là hướng dẫn.

Không cần tải `node_modules`. Không còn `app-enhancements.js`, `app-enhancements.css`, `presence.mjs` ở thư mục gốc hay thư mục build riêng: mã giao diện đã gộp vào `index.html`, backend đã gộp thành một Function.

## Đưa lên GitHub và public bằng Netlify

1. Đưa toàn bộ nội dung thư mục này vào root của repository GitHub, giữ nguyên thư mục `netlify/functions/`.
2. Trong Netlify, chọn **Add new site → Import an existing project** và kết nối repository. Cấu hình trong `netlify.toml` đã đặt publish directory là `.` và Functions directory là `netlify/functions`; không cần lệnh build riêng.
3. Trước khi deploy, vào **Project configuration → Environment variables** và tạo:
   - `SESSION_SECRET`: dùng `openssl rand -hex 32` để tạo khóa ngẫu nhiên; không dùng chuỗi mẫu hoặc đưa khóa này lên GitHub.
   - `ADMIN_KEY`: mật khẩu quản trị, phải trùng chính xác mật khẩu quản trị dùng trong ứng dụng; tối thiểu 8 ký tự, nên dài và riêng tư.
4. Deploy site. Kiểm tra `https://<tên-site>/api/ping`; phản hồi `{"ok":true,...}` cho biết API đã nhận request.
5. Mở ứng dụng và đồng ý điều khoản để dùng chat/kho nhạc chung. Nếu thiếu `SESSION_SECRET`, API sẽ không tạo phiên chat/nhạc.

Netlify Function hiện dùng Node 22 và Netlify Blobs. Không cần tạo database riêng. Không commit `ADMIN_KEY`, `SESSION_SECRET`, `.env` hoặc access token vào GitHub.

## Vì sao còn vài file ngoài `index.html`?

CSS và JavaScript phía trình duyệt đã được nhúng trong `index.html`. Tuy nhiên chat, MP3 chung và bảng xếp hạng cần chạy phía máy chủ; một file HTML tĩnh không thể giữ bí mật `SESSION_SECRET` hoặc tự cung cấp API. Vì vậy cần **một** Netlify Function cùng `netlify.toml` và phụ thuộc Blobs. `sw.js`, manifest và icon là các tệp riêng bắt buộc để giữ trải nghiệm PWA/cài ứng dụng.

## Quyền sử dụng kho MP3

Chỉ nhận `.mp3` tối đa 4,5 MB. Thành viên phải xác nhận quyền chia sẻ; nếu chọn nội dung đã được cấp phép hoặc có bản quyền, cần ghi nguồn/chủ sở hữu. Ghi nguồn không thay thế việc xin phép. Bài đã tải lên được lưu chung để thành viên nghe; có thể báo cáo và quản trị viên xử lý trong tab **Cộng đồng**.

## Kiểm thử và giới hạn

- Đã kiểm tra cú pháp các script nhúng và backend; mô phỏng các luồng chat, upload/range MP3, kiểm duyệt, bảng điểm Tiệm trà và tương tác của 20 tiện ích.
- Bản gốc `/home/user/uploads/` không bị sửa.
- Chưa liên kết/deploy lên một site Netlify thực tế; cần tự đặt biến môi trường và deploy theo các bước trên. Máy chủ preview tĩnh chỉ xem giao diện, không mô phỏng được API dùng chung.
- Các sửa kiến thức cấp 3 là rà soát mục tiêu ở các điểm dễ gây hiểu lầm, không phải thẩm định độc lập toàn bộ thư viện theo từng bộ sách.
