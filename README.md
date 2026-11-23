# ST-iPhonie Việt Hóa (`audio-st-viethoa`)

Tiện ích mở rộng đồng hành (companion extension) giúp **Việt hóa toàn bộ giao diện** của `ST-iPhonie` trên SillyTavern mà **không chỉnh sửa mã nguồn gốc**, giữ nguyên khả năng cập nhật `ST-iPhonie` từ GitHub.

## Tính năng chính
- Tự động Việt hóa cả **bảng điều khiển bên ngoài SillyTavern** (thanh cài đặt Extensions, nút mở điện thoại ở menu đũa phép, sóng âm thanh, thanh nổi, cửa sổ lời thoại, cuộc gọi, trình xem ảnh, Visual Novel, sách/truyện tranh, thông báo nổi `Toastr`) và **toàn bộ giao diện bên trong `iframe` điện thoại `ST-iPhonie`** (bao gồm cả mini-game & đại trò chơi).
- **Bảo vệ nội dung RP:** Tuyệt đối bỏ qua văn bản cốt truyện (`.mes_text`), nội dung tin nhắn nhân vật, bài đăng Khoảnh khắc/Diễn đàn, nội dung sách, và giá trị đang nhập trong `<input>` / `<textarea>` (chỉ dịch `placeholder` / `title`).
- **Tương thích `select/option`:** Tự giữ nguyên `value` gốc của `<option>` nếu thẻ không khai báo `value`, tránh làm hỏng logic chọn ngôn ngữ/giọng đọc.
- **Bật/Tắt tức thì:** Có thể chuyển đổi giữa Tiếng Việt và chữ gốc Tiếng Trung ngay trong bảng Extensions mà không cần tải lại trang.

## Cách cài đặt vào SillyTavern
1. Copy thư mục `audio-st-viethoa` này vào thư mục extension bên thứ ba của SillyTavern:
   ```text
   SillyTavern/public/scripts/extensions/third-party/audio-st-viethoa
   ```
   *(Hoặc tạo symlink/junction trỏ tới `D:\audio-st-viethoa`.)*
2. Tải lại trang SillyTavern (`F5`).
3. Vào mục **Extensions -> ST-iPhonie Việt Hóa** để bật/tắt dịch giao diện, dịch Toastr, hoặc bật chế độ Debug nếu muốn ghi nhận thêm chuỗi mới phát sinh khi `ST-iPhonie` ra bản cập nhật.
