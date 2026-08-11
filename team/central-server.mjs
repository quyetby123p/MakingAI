import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { centralPort, dataRoot, jobsRoot, maxBodyBytes, maxModels, maxProductViews, maxProducts, safeName, ensureDirectories } from "./config.mjs";
import { JsonStore } from "./store.mjs";
import { fileToDataUrl, outputUrl, parseDataUrl, saveDataUrl } from "./files.mjs";
import { driveStatus, publishImage } from "./drive.mjs";

ensureDirectories();
const store = new JsonStore();
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function html(res, body) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function previewUrlFor(url) { return `${url}?preview=1`; }

async function sendImage(res, sourceFile, previewFile = null) {
  let file = sourceFile;
  let contentType = path.extname(file).toLowerCase() === ".jpg" || path.extname(file).toLowerCase() === ".jpeg" ? "image/jpeg" : path.extname(file).toLowerCase() === ".webp" ? "image/webp" : "image/png";
  if (previewFile) {
    const sourceMtime = fs.statSync(sourceFile).mtimeMs;
    const previewReady = fs.existsSync(previewFile) && fs.statSync(previewFile).mtimeMs >= sourceMtime;
    if (!previewReady) {
      fs.mkdirSync(path.dirname(previewFile), { recursive: true });
      await sharp(sourceFile).rotate().resize({ width: 1100, height: 1400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82, progressive: true }).toFile(previewFile);
    }
    file = previewFile;
    contentType = "image/jpeg";
  }
  res.writeHead(200, { "content-type": contentType, "cache-control": previewFile ? "private, max-age=86400" : "private, max-age=60" });
  res.end(fs.readFileSync(file));
}

function sendError(res, error, fallback = "Có lỗi xảy ra.") {
  const status = Number(error?.status) || 500;
  json(res, status, { error: error?.message || fallback, code: error?.code || null, retryable: typeof error?.retryable === "boolean" ? error.retryable : status >= 500 });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size <= maxBodyBytes) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > maxBodyBytes) return reject(Object.assign(new Error("Dữ liệu vượt quá giới hạn 80 MB."), { status: 413, code: "payload_too_large" }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("JSON không hợp lệ."), { status: 400, code: "invalid_json" })); }
    });
    req.on("error", reject);
  });
}

function bearer(req, name = "authorization") {
  const value = req.headers[name] || "";
  return String(value).replace(/^Bearer\s+/i, "").trim();
}

function userFromRequest(req) {
  const user = store.session(bearer(req));
  if (!user) throw Object.assign(new Error("Phiên đã hết hạn. Nhập lại mã cá nhân."), { status: 401, code: "session_expired" });
  return user;
}

function helperFromRequest(req) {
  const match = store.helperByToken(req.headers["x-helper-token"] || bearer(req));
  if (!match) throw Object.assign(new Error("Helper token không hợp lệ hoặc đã bị khóa."), { status: 401, code: "helper_unauthorized" });
  return match;
}

function jobForUser(jobId, userId) {
  const job = store.getJob(jobId);
  if (!job || job.ownerId !== userId) throw Object.assign(new Error("Không tìm thấy job."), { status: 404, code: "job_not_found" });
  return job;
}

function validateImages(list, max, label) {
  if (!Array.isArray(list) || !list.length || list.length > max) throw Object.assign(new Error(`${label} phải có từ 1 đến ${max} ảnh.`), { status: 400, code: "invalid_image_count" });
  list.forEach(item => { const parsed = parseDataUrl(item); if (!parsed.buffer.length) throw new Error(`${label} có ảnh rỗng.`); });
}

function estimateJobSeconds(productCount, modelCount) {
  // Ước tính hiển thị cho người dùng; thời gian thật phụ thuộc helper và hàng đợi Codex.
  return Math.max(90, 45 + productCount * (90 + modelCount * 4));
}

function publicJob(job) {
  return {
    id: job.id, status: job.status, name: job.name, createdAt: job.createdAt, updatedAt: job.updatedAt,
    retryRequests: job.retryRequests || [], errors: job.errors || [], drive: job.drive || null,
    estimatedSeconds: job.estimatedSeconds || null, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    products: (job.products || []).map(product => ({
      id: product.id, name: product.name, status: product.status, progressMessage: product.progressMessage || null, error: product.error || null,
      selectedModel: product.selectedModel ?? null,
      modelReferenceUrl: product.selectedModel != null && job.input?.modelImages?.[product.selectedModel]
        ? `/api/jobs/${encodeURIComponent(job.id)}/references/model/${product.selectedModel}` : null,
      modelReferencePreviewUrl: product.selectedModel != null && job.input?.modelImages?.[product.selectedModel]
        ? previewUrlFor(`/api/jobs/${encodeURIComponent(job.id)}/references/model/${product.selectedModel}`) : null,
      evaluation: product.evaluation || null, outputs: (product.outputs || []).map((out, index) => ({
        version: out.version || index + 1, qc: out.qc || null, selected: out.selected === true,
        outputUrl: outputUrl(job.id, product.id), previewUrl: previewUrlFor(outputUrl(job.id, product.id)), drive: out.drive || null
      }))
    }))
  };
}

function jobPayloadForHelper(job) {
  const data = {
    id: job.id, name: job.name, retryRequests: job.retryRequests || [], renderRequests: job.renderRequests || [], modelImages: job.input.modelImages.map(fileToDataUrl),
    products: job.products.map(product => ({
      id: product.id, name: product.name, productImages: product.inputFiles.map(fileToDataUrl),
      evaluation: product.evaluation || null, selectedModel: product.selectedModel ?? null,
      outputs: product.outputs || [], lastQc: product.lastQc || null
    }))
  };
  return data;
}

function markOldHelpersOffline() {
  const cutoff = Date.now() - Number(process.env.STUDIO_HELPER_OFFLINE_MS || 45_000);
  for (const helper of store.state.helpers) {
    if (helper.lastSeenAt && Date.parse(helper.lastSeenAt) < cutoff) helper.authenticated = false;
  }
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/healthz") return json(res, 200, { ok: true, service: "studio-flow-team", drive: driveStatus() });
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) return html(res, fs.readFileSync(path.join(webRoot, "team", "team-ui.html"), "utf8"));

  if (req.method === "POST" && pathname === "/api/session/claim") {
    const body = await readBody(req);
    const user = store.userByPersonalCode(body.code);
    if (!user) throw Object.assign(new Error("Mã cá nhân không đúng hoặc đã bị khóa."), { status: 401, code: "invalid_personal_code" });
    const sessionToken = store.createSession(user.id);
    store.audit("session.claimed", user.id, user.id);
    store.save();
    return json(res, 200, { token: sessionToken, user: { id: user.id, name: user.name }, helpers: store.listHelpers(user.id) });
  }

  if (pathname.startsWith("/internal/")) {
    const { user, helper } = helperFromRequest(req);
    if (req.method === "POST" && pathname === "/internal/helpers/poll") {
      const body = await readBody(req);
      const authenticated = body.authenticated === true;
      store.touchHelper(body.helperId || helper.id, user.id, authenticated);
      markOldHelpersOffline();
      const pending = store.listJobs(user.id).filter(job => ["WAITING_FOR_HELPER", "QUEUED"].includes(job.status)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
      if (!pending) return json(res, 200, { job: null, helper: store.listHelpers(user.id).find(item => item.userId === user.id) });
      store.updateJob(pending.id, { status: "RUNNING", helperId: body.helperId || helper.id, startedAt: new Date().toISOString() });
      return json(res, 200, { job: jobPayloadForHelper(pending), helper: store.listHelpers(user.id).find(item => item.userId === user.id) });
    }

    if (req.method === "POST" && pathname === "/internal/helpers/progress") {
      const body = await readBody(req);
      const job = store.getJob(body.jobId);
      if (!job || job.ownerId !== user.id) throw Object.assign(new Error("Job không thuộc helper này."), { status: 404, code: "job_not_found" });
      const product = (job.products || []).find(item => item.id === body.productId);
      if (!product) throw Object.assign(new Error("Không tìm thấy sản phẩm trong job."), { status: 404, code: "product_not_found" });
      if (body.evaluation) product.evaluation = body.evaluation;
      if (Number.isInteger(body.selectedModel)) product.selectedModel = body.selectedModel;
      product.status = String(body.status || "RUNNING").slice(0, 40);
      product.progressMessage = String(body.message || "").slice(0, 200) || null;
      store.updateJob(job.id, { products: job.products, status: String(body.jobStatus || "RUNNING").slice(0, 40) });
      return json(res, 200, { ok: true, job: publicJob(store.getJob(job.id)) });
    }

    if (req.method === "POST" && pathname === "/internal/helpers/result") {
      const body = await readBody(req);
      const job = store.getJob(body.jobId);
      if (!job || job.ownerId !== user.id) throw Object.assign(new Error("Job không thuộc helper này."), { status: 404, code: "job_not_found" });
      const jobDir = path.join(jobsRoot, safeName(job.id), "outputs");
      fs.mkdirSync(jobDir, { recursive: true });
      const products = job.products || [];
      const errors = [];
      const evaluationOnly = body.status === "AWAITING_EVALUATION_APPROVAL";
      for (const result of body.products || []) {
        const product = products.find(item => item.id === result.id);
        if (!product) continue;
        if (result.error) { product.error = result.error; product.progressMessage = null; product.status = "FAILED"; errors.push({ productId: product.id, error: result.error }); continue; }
        product.error = null;
        product.progressMessage = null;
        product.status = evaluationOnly ? "EVALUATED" : "DONE";
        product.evaluation = result.evaluation || product.evaluation;
        product.selectedModel = result.selectedModel ?? product.selectedModel;
        if (!evaluationOnly && result.output?.dataUrl) {
          const file = saveDataUrl(job.id, "outputs", `${product.id}-v${(product.outputs?.length || 0) + 1}`, result.output.dataUrl);
          const out = { version: (product.outputs?.length || 0) + 1, path: file, qc: result.qc || null, selected: true, createdAt: new Date().toISOString() };
          product.outputs = (product.outputs || []).map(item => ({ ...item, selected: false }));
          product.outputs.push(out);
          product.lastQc = result.qc || null;
        }
      }
      job.retryRequests = [];
      job.renderRequests = [];
      job.errors = errors;
      const hasError = products.some(product => product.status === "FAILED");
      const nextStatus = body.status === "CANCELLED" ? "CANCELLED" : hasError ? "FAILED" : evaluationOnly ? "AWAITING_EVALUATION_APPROVAL" : "DONE";
      store.updateJob(job.id, { products, retryRequests: [], renderRequests: [], errors, status: nextStatus, finishedAt: evaluationOnly ? null : new Date().toISOString(), evaluationCompletedAt: evaluationOnly ? new Date().toISOString() : job.evaluationCompletedAt || null });
      store.audit(evaluationOnly ? "job.evaluated" : "job.finished", user.id, job.id, { status: nextStatus, helperId: helper.id });
      store.save();
      return json(res, 200, { ok: true, job: publicJob(store.getJob(job.id)) });
    }

    if (req.method === "GET" && pathname === "/internal/helpers/status") return json(res, 200, { helper: store.listHelpers(user.id) });
    return json(res, 404, { error: "Internal endpoint không tồn tại." });
  }

  if (pathname === "/api/admin/users") {
    if (!process.env.STUDIO_ADMIN_KEY || req.headers["x-admin-key"] !== process.env.STUDIO_ADMIN_KEY) throw Object.assign(new Error("Admin key không hợp lệ."), { status: 403 });
    return json(res, 200, { users: store.listUsers(), helpers: store.listHelpers() });
  }
  const adminUser = pathname.match(/^\/api\/admin\/users\/([^/]+)\/(enable|disable)$/);
  if (adminUser) {
    if (!process.env.STUDIO_ADMIN_KEY || req.headers["x-admin-key"] !== process.env.STUDIO_ADMIN_KEY) throw Object.assign(new Error("Admin key không hợp lệ."), { status: 403 });
    const updated = store.setUserEnabled(adminUser[1], adminUser[2] === "enable");
    if (!updated) return json(res, 404, { error: "Không tìm thấy user." });
    return json(res, 200, { user: updated });
  }

  const user = userFromRequest(req);
  markOldHelpersOffline();

  if (req.method === "GET" && pathname === "/api/me") return json(res, 200, { user: { id: user.id, name: user.name }, helpers: store.listHelpers(user.id), drive: driveStatus() });
  if (req.method === "GET" && pathname === "/api/status") return json(res, 200, { ok: true, helpers: store.listHelpers(user.id), drive: driveStatus() });
  if (req.method === "GET" && pathname === "/api/jobs") return json(res, 200, { jobs: store.listJobs(user.id).map(publicJob) });
  if (req.method === "GET" && pathname === "/api/assets") return json(res, 200, { assets: store.listAssets() });
  if (req.method === "POST" && pathname === "/api/account/reset") return json(res, 200, { ok: true, removed: store.resetUserData(user.id) });

  if (req.method === "POST" && pathname === "/api/jobs") {
    const body = await readBody(req);
    if (!Array.isArray(body.products) || !body.products.length || body.products.length > maxProducts) throw Object.assign(new Error(`Mỗi job cần từ 1 đến ${maxProducts} sản phẩm.`), { status: 400, code: "invalid_product_count" });
    validateImages(body.modelImages, maxModels, "Ảnh model");
    const jobId = `job_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const inputModelFiles = body.modelImages.map((value, index) => saveDataUrl(jobId, "inputs", `model-${index + 1}`, value));
    const products = body.products.map((item, index) => {
      const refs = Array.isArray(item.productImages) ? item.productImages : [];
      validateImages(refs, maxProductViews, `Ảnh sản phẩm ${index + 1}`);
      return { id: `product_${index + 1}`, name: String(item.name || `Sản phẩm ${index + 1}`).slice(0, 100), inputFiles: refs.map((value, refIndex) => saveDataUrl(jobId, "inputs", `product-${index + 1}-view-${refIndex + 1}`, value)), status: "WAITING", evaluation: null, selectedModel: null, outputs: [], lastQc: null, error: null };
    });
    const job = store.createJob({ id: jobId, ownerId: user.id, name: String(body.name || "Studio Flow job").slice(0, 120), status: "WAITING_FOR_HELPER", helperId: null, input: { modelImages: inputModelFiles }, products, retryRequests: [], errors: [], drive: null, estimatedSeconds: estimateJobSeconds(body.products.length, body.modelImages.length), jobDir: path.join(jobsRoot, jobId) });
    return json(res, 201, { job: publicJob(job) });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (jobMatch) {
    const [, jobId, action, action2] = jobMatch;
    const job = jobForUser(jobId, user.id);
    if (req.method === "GET" && !action) return json(res, 200, { job: publicJob(job) });
    if (req.method === "DELETE" && !action) {
      store.deleteJobFiles(job.id);
      const deleted = store.deleteJob(job.id, user.id);
      store.audit("job.deleted", user.id, job.id);
      store.save();
      return json(res, 200, { ok: Boolean(deleted), jobId: job.id });
    }
    if (req.method === "POST" && action === "approve-render") {
      const body = await readBody(req);
      const requested = Array.isArray(body.productIds) && body.productIds.length ? body.productIds : job.products.map(item => item.id);
      const selected = job.products.filter(product => requested.includes(product.id));
      if (!selected.length || selected.some(product => !product.evaluation)) throw Object.assign(new Error("Cần có đánh giá trước khi duyệt tạo ảnh."), { status: 422, code: "evaluation_required" });
      const renderRequests = selected.map(product => product.id);
      for (const product of selected) { product.status = "WAITING_FOR_RENDER"; product.progressMessage = "Đã duyệt; đang chờ helper tạo ảnh."; product.error = null; }
      store.updateJob(job.id, { products: job.products, renderRequests, retryRequests: [], status: "WAITING_FOR_HELPER", helperId: null, startedAt: null, errors: [] });
      store.audit("job.render_approved", user.id, job.id, { productIds: renderRequests });
      return json(res, 200, { job: publicJob(store.getJob(job.id)) });
    }
    if (req.method === "GET" && action === "events") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      let last = "";
      const timer = setInterval(() => {
        const current = store.getJob(jobId);
        if (!current) return;
        const payload = JSON.stringify(publicJob(current));
        if (payload !== last) { last = payload; res.write(`event: job\ndata: ${payload}\n\n`); }
        if (["DONE", "FAILED", "CANCELLED"].includes(current.status)) { clearInterval(timer); res.end(); }
      }, 1000);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (req.method === "POST" && action === "retry") {
      const body = await readBody(req);
      const product = job.products.find(item => item.id === body.productId);
      if (!product) throw Object.assign(new Error("Không tìm thấy sản phẩm cần tạo lại."), { status: 404 });
      if ((product.outputs || []).length >= 4) throw Object.assign(new Error("Sản phẩm đã dùng hết 3 lần tạo lại."), { status: 422, code: "max_versions" });
      job.retryRequests = [...new Set([...(job.retryRequests || []), product.id])];
      job.renderRequests = [...new Set([...(job.renderRequests || []), product.id])];
      product.status = "WAITING_FOR_RENDER"; product.error = null; product.progressMessage = "Đang chờ helper tạo lại ảnh.";
      store.updateJob(job.id, { retryRequests: job.retryRequests, renderRequests: job.renderRequests, products: job.products, status: "WAITING_FOR_HELPER", errors: [] });
      return json(res, 200, { job: publicJob(store.getJob(job.id)) });
    }
    if (req.method === "POST" && action === "cancel") {
      store.updateJob(job.id, { status: "CANCELLED", retryRequests: [], renderRequests: [] });
      return json(res, 200, { job: publicJob(store.getJob(job.id)) });
    }
    if (req.method === "POST" && action === "approve") {
      const body = await readBody(req);
      const approvedIds = Array.isArray(body.productIds) && body.productIds.length ? body.productIds : job.products.map(item => item.id);
      const driveResults = [];
      for (const product of job.products.filter(item => approvedIds.includes(item.id))) {
        const selected = [...(product.outputs || [])].reverse().find(item => item.selected !== false);
        if (!selected?.path) continue;
        try {
          const published = await publishImage({ userName: user.name, jobId: job.id, productName: product.name, filePath: selected.path });
          selected.drive = published;
          driveResults.push({ productId: product.id, ...published });
          if (published.ok) store.addAsset({ ownerId: user.id, jobId: job.id, productId: product.id, name: product.name, path: selected.path, drive: published });
        } catch (error) { driveResults.push({ productId: product.id, ok: false, error: error.message }); }
      }
      store.updateJob(job.id, { status: "APPROVED", drive: driveResults, products: job.products });
      return json(res, 200, { job: publicJob(store.getJob(job.id)), drive: driveResults });
    }
  }

  const outputMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/products\/([^/]+)\/output$/);
  if (req.method === "GET" && outputMatch) {
    const job = jobForUser(outputMatch[1], user.id);
    const product = job.products.find(item => item.id === outputMatch[2]);
    const output = [...(product?.outputs || [])].reverse().find(item => item.selected !== false) || product?.outputs?.at(-1);
    if (!output?.path || !fs.existsSync(output.path)) return json(res, 404, { error: "Chưa có ảnh kết quả." });
    const preview = url.searchParams.get("preview") === "1" ? path.join(jobsRoot, safeName(job.id), "previews", `${safeName(product.id)}-output.jpg`) : null;
    return sendImage(res, output.path, preview);
  }

  const modelReferenceMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/references\/model\/(\d+)$/);
  if (req.method === "GET" && modelReferenceMatch) {
    const job = jobForUser(modelReferenceMatch[1], user.id);
    const file = job.input?.modelImages?.[Number(modelReferenceMatch[2])];
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: "Không tìm thấy ảnh model gốc." });
    const preview = url.searchParams.get("preview") === "1" ? path.join(jobsRoot, safeName(job.id), "previews", `model-${modelReferenceMatch[2]}.jpg`) : null;
    return sendImage(res, file, preview);
  }

  return json(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => handle(req, res).catch(error => sendError(res, error)));
server.listen(centralPort, "0.0.0.0", () => {
  console.log(`Studio Flow Team: http://127.0.0.1:${centralPort}`);
  console.log(`Data: ${dataRoot}`);
  console.log(`Drive: ${driveStatus().configured ? "configured" : "not configured (local fallback)"}`);
});

export { store, server, publicJob, jobPayloadForHelper };
