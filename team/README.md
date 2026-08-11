# Studio Flow Team

Phiên bản team của Studio Flow: website dùng chung nhận job, helper chạy trên máy thành viên và dùng Codex CLI/ChatGPT đăng nhập tại máy đó để đánh giá, render và QC ảnh.

## Chạy central server local

```powershell
Copy-Item team/.env.example team/.env
# Đổi STUDIO_BOOTSTRAP_CODE, STUDIO_BOOTSTRAP_HELPER_TOKEN và STUDIO_ADMIN_KEY
npm run team:start
```

Mở `http://127.0.0.1:4180`. MVP dùng file store ở `team-data/`, phù hợp pilot một VPS/một process; volume phải được backup. Store đã tách qua lớp `JsonStore` để thay bằng PostgreSQL khi scale nhiều process.

## Cấu hình nhiều thành viên

Đặt trong `team/.env` một JSON duy nhất, không commit file này:

```env
STUDIO_TEAM_USERS_JSON=[{"id":"hoa","name":"Hoa","personalCode":"ma-ca-nhan-hoa","helperToken":"helper-token-hoa"},{"id":"nguyen","name":"Nguyen","personalCode":"ma-ca-nhan-nguyen","helperToken":"helper-token-nguyen"}]
```

Mã cá nhân và helper token chỉ được hash trong store. Nếu lộ mã, admin khóa user bằng:

```powershell
curl -H "x-admin-key: $env:STUDIO_ADMIN_KEY" https://your-domain/api/admin/users
curl -X POST -H "x-admin-key: $env:STUDIO_ADMIN_KEY" https://your-domain/api/admin/users/hoa/disable
```

## Chạy helper trên máy thành viên

Yêu cầu Node.js 20+, Codex CLI và lần đầu chọn `Sign in with ChatGPT` trên chính máy thành viên.

```powershell
$env:STUDIO_CENTRAL_URL="https://your-domain.example"
$env:STUDIO_HELPER_ID="hoa-laptop"
$env:STUDIO_HELPER_TOKEN="helper-token-hoa"
npm run team:helper
```

Helper tự khởi động local engine từ `server.mjs`, kiểm tra `codex login status`, rồi polling central server. Không cần mở port trên máy thành viên và không gửi credential ChatGPT lên VPS.

macOS/Linux dùng cùng lệnh:

```bash
STUDIO_CENTRAL_URL=https://your-domain.example \
STUDIO_HELPER_ID=hoa-laptop \
STUDIO_HELPER_TOKEN=helper-token-hoa \
npm run team:helper
```

Có thể dùng systemd, launchd hoặc Task Scheduler để chạy nền; không lưu token trong Git.

## Google Drive

Central server chỉ upload Drive khi có đủ các biến sau:

```env
STUDIO_DRIVE_ROOT_ID=...
STUDIO_GOOGLE_OAUTH_CLIENT_ID=...
STUDIO_GOOGLE_OAUTH_CLIENT_SECRET=...
STUDIO_GOOGLE_OAUTH_REFRESH_TOKEN=...
```

Nếu chưa cấu hình Drive, ảnh vẫn được lưu trong `team-data/jobs/` để pilot không bị chặn. Khi cấu hình đủ, nút `Duyệt ảnh` tạo cấu trúc `AI Garment Studio/<user>/<job>/` và ghi asset vào thư viện team.

## Docker/VPS

```bash
cp team/.env.example .env
# điền secret thật vào .env
docker compose up -d --build
curl https://your-domain.example/healthz
```

Reverse proxy (Nginx/Caddy/Cloudflare Tunnel) phải chuyển HTTPS vào cổng `4180`. Không public thư mục `team-data` trực tiếp.

## Kiểm thử

```bash
npm run team:test
```

Test hiện có kiểm tra hash credential, session claim, giới hạn job và central API. Luồng render thật cần chạy pilot trên từng hệ điều hành vì phụ thuộc tài khoản ChatGPT/Codex và quyền image generation của tài khoản đó.
