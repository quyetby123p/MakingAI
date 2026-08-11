import fs from "node:fs";
import path from "node:path";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

function configured() {
  return Boolean(process.env.STUDIO_GOOGLE_OAUTH_CLIENT_ID && process.env.STUDIO_GOOGLE_OAUTH_CLIENT_SECRET && process.env.STUDIO_GOOGLE_OAUTH_REFRESH_TOKEN && (process.env.STUDIO_DRIVE_ROOT_ID || process.env.VAYXA_DRIVE_ROOT_ID));
}

let cachedToken = null;
async function accessToken() {
  if (!configured()) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const body = new URLSearchParams({ client_id: process.env.STUDIO_GOOGLE_OAUTH_CLIENT_ID, client_secret: process.env.STUDIO_GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: process.env.STUDIO_GOOGLE_OAUTH_REFRESH_TOKEN, grant_type: "refresh_token" });
  const response = await fetch(process.env.STUDIO_GOOGLE_OAUTH_TOKEN_URI || "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || "Không lấy được Google access token.");
  cachedToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function driveRequest(url, options = {}) {
  const token = await accessToken();
  if (!token) return { skipped: true, reason: "Chưa cấu hình Google Drive OAuth hoặc STUDIO_DRIVE_ROOT_ID." };
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Google Drive trả lỗi ${response.status}.`);
  return data;
}

async function ensureFolder(name, parentId) {
  const query = encodeURIComponent(`name = '${String(name).replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await driveRequest(`${DRIVE_API}/files?q=${query}&fields=files(id,name)&pageSize=1`);
  if (found.skipped) return found;
  if (found.files?.[0]) return found.files[0];
  return driveRequest(`${DRIVE_API}/files?fields=id,name`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }) });
}

export async function publishImage({ userName, jobId, productName, filePath }) {
  if (!configured()) return { ok: false, skipped: true, reason: "Google Drive chưa cấu hình; ảnh vẫn được giữ trên server." };
  const rootId = process.env.STUDIO_DRIVE_ROOT_ID || process.env.VAYXA_DRIVE_ROOT_ID;
  const team = await ensureFolder(process.env.STUDIO_DRIVE_FOLDER_NAME || "AI Garment Studio", rootId);
  const user = await ensureFolder(userName || "Team", team.id);
  const job = await ensureFolder(jobId, user.id);
  const fileName = `${productName || "output"}-${path.basename(filePath)}`;
  const content = fs.readFileSync(filePath);
  const boundary = `studio-flow-${Date.now().toString(36)}`;
  const metadata = Buffer.from(JSON.stringify({ name: fileName, parents: [job.id] }));
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`), metadata,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`), content,
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  const uploaded = await driveRequest(`${UPLOAD_API}?uploadType=multipart&fields=id,name,webViewLink,webContentLink`, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}`, "content-length": String(body.length) }, body });
  return { ok: true, ...uploaded };
}

export function driveStatus() { return { configured: configured(), rootId: process.env.STUDIO_DRIVE_ROOT_ID || process.env.VAYXA_DRIVE_ROOT_ID || null }; }
