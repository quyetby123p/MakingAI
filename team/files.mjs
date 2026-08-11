import fs from "node:fs";
import path from "node:path";
import { jobsRoot, mimeExtension, safeName } from "./config.mjs";

export function parseDataUrl(value) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(String(value || ""));
  if (!match) throw new Error("Ảnh đầu vào không hợp lệ.");
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

export function dataUrlFromBuffer(buffer, mime = "image/png") {
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}

export function saveDataUrl(jobId, subdir, filename, value) {
  const parsed = parseDataUrl(value);
  const containerParts = String(jobId || "job").split(/[\\/]+/).filter(Boolean).map(part => safeName(part));
  const dir = path.join(jobsRoot, ...containerParts, safeName(subdir));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(path.parse(filename || "image").name)}.${mimeExtension(parsed.mime)}`);
  fs.writeFileSync(file, parsed.buffer);
  return file;
}

export function fileToDataUrl(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return dataUrlFromBuffer(fs.readFileSync(file), mime);
}

export function outputUrl(jobId, productId) { return `/api/jobs/${encodeURIComponent(jobId)}/products/${encodeURIComponent(productId)}/output`; }
