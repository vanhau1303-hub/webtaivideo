# HD Video Downloader (web app)

Dán link trang có video, app sẽ tìm và tải bản **có độ phân giải cao nhất**.

## Chạy

Bấm đúp `start.bat`. Lần đầu nó sẽ tự cài thư viện, sau đó mở trình duyệt ở http://localhost:8686.

Hoặc chạy thủ công:

```bash
npm install
```

```bash
python -m pip install --user -U yt-dlp
```

```bash
npm start
```

Cần có: Node.js 20 trở lên, Python 3 (để chạy yt-dlp), và một trong ba trình duyệt Chrome, Edge hoặc Cốc Cốc (app dùng trình duyệt có sẵn trên máy để quét trang ở chế độ ẩn).

## Dùng qua Internet (Cloudflare)

Địa chỉ cố định: **https://video4urduck.sickduck.workers.dev**

```
Điện thoại / máy khác ──► Worker video4urduck (Cloudflare) ──► Cloudflare Tunnel ──► máy nhà (run.js → server.js)
```

- `start.bat` chạy `run.js`, và `run.js` làm các việc sau:
  - bật `server.js`, nếu lỗi thì tự bật lại;
  - mở Cloudflare Tunnel (link `*.trycloudflare.com` đổi mỗi lần khởi động) rồi báo link mới cho Worker;
  - **mỗi phút kiểm tra GitHub** nhánh `main`. Có commit mới thì `git pull`, chạy `npm install` nếu thư viện thay đổi, rồi khởi động lại. Nếu đang có video tải dở thì chờ xong mới cập nhật.
- Worker (`cloudflare/worker.js`) giữ link tunnel hiện tại trong KV và chuyển tiếp mọi request về đó. Khi máy nhà tắt, nó hiện trang "Máy chủ đang tắt".
- Web có **mật khẩu**, đặt trong `.env` (`APP_PASSWORD`). Khi chạy ở chế độ này, web từ chối quét các địa chỉ mạng nội bộ.
- Máy phải bật và đang chạy `start.bat` thì web mới dùng được.

Cấu hình nằm trong `.env`, tạo từ `.env.example`. File này không đưa lên GitHub.

Cập nhật Worker (khi sửa `cloudflare/worker.js`):

```bash
cd cloudflare && npx wrangler deploy
```

## Cơ chế lấy video

App chọn một trong ba cách. Ở chế độ **Tự động**, nó tự quyết định cách nào dùng trước.

1. **Link trực tiếp** (`.m3u8`, `.mpd`, `.mp4`…): đọc manifest ngay, không cần mở trang.
2. **Quét trang như Cốc Cốc**: mở trang trong Chrome, Edge hoặc Cốc Cốc chạy ẩn, tự bấm nút Play (kể cả trình phát nằm trong iframe), tự đóng popup quảng cáo, và nghe toàn bộ request mạng để bắt luồng HLS, DASH hoặc MP4. App ghi lại Referer, Origin, Cookie và User-Agent mà trang đã gửi, nên vẫn tải được từ các CDN chặn hotlink.
3. **yt-dlp**: dùng cho YouTube, Facebook, TikTok, Instagram, X, Vimeo, Dailymotion, Bilibili… (hơn 1.000 trang có bộ trích xuất riêng).

Thứ tự ở chế độ Tự động:

- Trang lớn có trong danh sách của yt-dlp: thử yt-dlp trước, không được thì quét trang.
- Các trang còn lại: quét trang trước, không bắt được gì thì thử yt-dlp.

Sau khi có nguồn, app đọc **mọi mức chất lượng** trong manifest, kể cả những mức trình phát chưa tải tới vì đang bắt đầu ở bản thấp, rồi chọn bản cao nhất. Nguồn ngắn hơn một nửa video chính (thường là quảng cáo) bị bỏ qua.

## Tải và ghép

- Segment HLS/DASH được tải song song 8 luồng, tự thử lại khi lỗi, và ghi thẳng ra đĩa nên không tốn RAM.
- Tự giải mã HLS AES-128 và tự cắt header ảnh giả mà một số trang phim chèn vào trước segment `.ts`.
- ffmpeg ghép video và audio tách riêng, rồi đóng gói thành **MP4** bằng cách copy stream, nên giữ nguyên chất lượng gốc.
- File xong sẽ tự lưu về máy. File tạm trên server bị xóa sau 3 giờ hoặc khi khởi động lại.

## Bản H.264 (tương thích mọi máy)

Khi bản nét nhất dùng codec mới (AV1, VP9, H.265), bên cạnh nút **Tải bản nét nhất** sẽ có thêm nút **H.264**:

- Nếu trang có sẵn bản H.264, app tải bản H.264 cao nhất kèm audio AAC. Với YouTube thường là 1080p.
- Nếu trang không có bản H.264 nào, app tải bản nét nhất rồi dùng ffmpeg chuyển mã sang H.264 + AAC (CRF 18, giữ nguyên độ phân giải). Cách này lâu hơn và tốn CPU, tiến trình được hiện riêng.

File H.264 phát được trên mọi TV, điện thoại và máy tính, kể cả máy cũ.

## Giới hạn

- **DRM** (Netflix, gói trả phí của FPT Play, VieON…): app phát hiện và báo là không tải được.
- **Livestream** đang phát: chưa hỗ trợ.
- **Trang cần đăng nhập**: trình duyệt ẩn chưa có phiên đăng nhập của bạn.

## Bảo mật

Mặc định server chỉ nghe ở `127.0.0.1`, tức chỉ máy này dùng được. Muốn dùng từ điện thoại trong cùng mạng LAN thì chạy với `HOST=0.0.0.0`. **Không mở ra Internet**: server sẽ tải bất kỳ link nào được gửi tới.

Chỉ dùng để tải nội dung bạn có quyền lưu.

## Cấu trúc

```
server.js          HTTP server + API (/api/analyze, /api/download, /api/jobs)
src/resolve.js     Chọn cách lấy video, gộp nguồn, chọn bản cao nhất
src/sniffer.js     Trình duyệt ẩn: mở trang, bấm Play, bắt request media
src/ytdlp.js       Gọi yt-dlp: lấy danh sách định dạng, tải, báo tiến trình
src/analyze.js     Liệt kê chất lượng HLS/DASH, lập kế hoạch tải
src/downloader.js  Tải segment song song, giải mã, ghi đĩa, ghép bằng ffmpeg
src/hls.js         Parse m3u8 (master/media, AES-128, BYTERANGE, EXT-X-MAP)
src/dash.js        Parse MPD (SegmentTemplate/Timeline, SegmentList, SegmentBase)
src/mp4.js         Đọc box MP4, sidx
src/net.js         fetch kèm Referer/Cookie/UA, retry, Range
public/            Giao diện web
```
