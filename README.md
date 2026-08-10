# Studio Flow

Công cụ chuyển trang phục từ ảnh sản phẩm sang ảnh người mẫu bằng AI, dành cho studio thời trang.

Quy trình 5 bước tuyến tính: **ảnh sản phẩm → ảnh người mẫu → AI chấm đầu vào → tạo ảnh → kiểm tra chất lượng**. Toàn bộ chạy cục bộ, ảnh lưu thẳng xuống máy.

---

## Chạy được bằng hai đường

| Backend | Chi phí | Yêu cầu |
|---|---|---|
| `codex` *(mặc định)* | **0 đồng** — dùng hạn mức gói ChatGPT | Gói ChatGPT Plus/Pro/Team + Codex CLI đã đăng nhập |
| `api` | Tính phí theo lượt gọi | `OPENAI_API_KEY` có credit |

Đường `codex` gọi `codex exec`, để agent dùng công cụ `image_gen` sẵn có. Không cần API key, nhưng chậm hơn (~60–80 giây mỗi lượt) và không ép được kích thước ảnh đầu ra.

---

## Dành cho người mới — cài trong 3 bước

Không cần biết gì về lập trình.

1. Bấm **Code → Download ZIP** ở đầu trang này, rồi giải nén ra Desktop.
2. Mở thư mục vừa giải nén, **bấm đúp `SETUP.bat`**.
3. Làm theo hướng dẫn hiện trên màn hình.

Trình cài đặt tự lo phần còn lại: kiểm tra Node.js và tự cài nếu thiếu, kiểm tra
đăng nhập ChatGPT, khởi động rồi mở sẵn trình duyệt.

**Máy cần có:** Windows, và một tài khoản ChatGPT gói **Plus / Pro / Team**.
Nếu chưa cài ứng dụng ChatGPT, trình cài đặt sẽ mở trang tải cho bạn.

Những lần sau chỉ cần bấm đúp `SETUP.bat` là chạy.

> Mỗi máy phải đăng nhập ChatGPT riêng. Hạn mức tính theo **tài khoản**, không
> theo máy — nên mỗi người dùng nên có tài khoản có gói của riêng mình.

---

## Cài đặt

**Cần có:** [Node.js](https://nodejs.org) 18 trở lên.

```bash
git clone <đường-dẫn-repo-của-bạn> studio-flow
cd studio-flow
```

Không có thư viện phụ thuộc nào — không cần `npm install`.

### Nếu dùng gói ChatGPT (khuyến nghị)

Cài [ChatGPT Desktop](https://openai.com/chatgpt/download) hoặc Codex CLI, rồi đăng nhập:

```bash
codex login
```

Kiểm tra lại, phải thấy dòng `Logged in using ChatGPT`:

```bash
codex login status
```

Server tự dò `codex` trên Windows, macOS, Linux và trong `PATH`. Nếu máy bạn cài chỗ lạ, chỉ đường bằng biến `CODEX_CLI_PATH`.

### Nếu dùng API trả phí

```bash
# Windows PowerShell
$env:STUDIO_BACKEND="api"; $env:OPENAI_API_KEY="sk-..."; node server.mjs
```

Trên Windows còn có `start-studio-flow.bat` — nó lưu khoá đã mã hoá bằng DPAPI vào `%LOCALAPPDATA%\StudioFlow\`, **ngoài** thư mục repo.

---

## Khởi động

```bash
node server.mjs
```

Mở http://127.0.0.1:4173

Windows có thể bấm thẳng `start-studio-flow.bat`.

---

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `STUDIO_BACKEND` | `codex` | `codex` dùng hạn mức gói, `api` dùng khoá trả phí |
| `STUDIO_PORT` | `4173` | Cổng phục vụ |
| `OPENAI_API_KEY` | — | Chỉ cần khi `STUDIO_BACKEND=api` |
| `CODEX_CLI_PATH` | tự dò | Chỉ đường tới `codex` nếu dò không ra |
| `STUDIO_EVAL_TIMEOUT_MS` | `360000` | Hạn giờ mỗi lượt chấm |
| `STUDIO_RENDER_TIMEOUT_MS` | `600000` | Hạn giờ mỗi lượt tạo ảnh |
| `STUDIO_KEEP_JOBS` | `false` | Đặt `true` để giữ `.codex-jobs/` mà xem prompt đã gửi |
| `ALLOW_MANUAL_OVERRIDE` | `true` | Cho phép tạo ảnh dù điểm đầu vào thấp |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` | Model chấm điểm khi chạy đường `api` |

---

## Giới hạn nghiệp vụ

Cố định trong mã, đổi thì phải sửa cả `server.mjs` lẫn `studio-flow-ui.html`:

- Tối đa **5 sản phẩm** mỗi lượt
- Mỗi sản phẩm **1 ảnh chính + tối đa 7 góc bổ sung**
- **1–10 ảnh người mẫu**, dùng chung cho mọi sản phẩm trong lượt
- **4 phiên bản** mỗi sản phẩm: bản đầu + 3 lần tạo lại
- Điểm đầu vào chỉ mang tính tư vấn — **ảnh điểm thấp vẫn tạo được**

---

## Ảnh lưu ở đâu

Vào `generated/` cạnh `server.mjs`, đặt tên theo `<tên-sản-phẩm>-<thời-gian-UTC>.png`. Thư mục này bị `.gitignore` loại trừ.

Phiên làm việc lưu trong IndexedDB của trình duyệt, nên tải lại trang không mất việc đang dở.

---

## Cấu trúc

```
server.mjs               máy chủ HTTP + gọi AI (không thư viện ngoài)
studio-flow-ui.html      toàn bộ giao diện trong một tệp
launch-studio-flow.ps1   khởi động cho Windows, có xử lý khoá API
start-studio-flow.bat    bấm đúp để chạy
docs/                    nghiên cứu giao diện, bản thiết kế tham chiếu
```

---

## Lưu ý khi chạy máy khác

- **Windows** chạy đủ mọi thứ, kể cả script khởi động.
- **macOS / Linux** chạy được `node server.mjs`; hai tệp `.ps1` và `.bat` chỉ dành cho Windows.
- Giao diện cần Internet để tải phông **Playfair Display** và **Geist** từ Google Fonts. Mất mạng thì vẫn chạy nhưng rơi về phông hệ thống.
- Đường `codex` cần đăng nhập lại trên từng máy — thông tin đăng nhập nằm ở `~/.codex/auth.json`, **không** đi kèm repo.
