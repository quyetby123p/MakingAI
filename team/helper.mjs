import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { centralOrigin, helperId, repoRoot } from "./config.mjs";
import { dataUrlFromBuffer } from "./files.mjs";
import { isRetryableError, retryInstructions, selectCandidate } from "./workflow-core.mjs";

const token = process.env.STUDIO_HELPER_TOKEN || "demo-helper";
const localPort = Number(process.env.STUDIO_LOCAL_ENGINE_PORT || 4173 + Math.floor(Math.random() * 100));
const localOrigin = `http://127.0.0.1:${localPort}`;
let engine = null;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function requestJson(url, options = {}) {
  return fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, data });
    return data;
  });
}

async function waitForEngine() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await requestJson(`${localOrigin}/api/status`, { method: "GET", headers: {} }); }
    catch { await sleep(500); }
  }
  throw new Error("Local Studio Flow engine không khởi động được.");
}

function startEngine() {
  if (engine) return;
  engine = spawn(process.execPath, [path.join(repoRoot, "server.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, STUDIO_PORT: String(localPort), STUDIO_BACKEND: "codex", STUDIO_KEEP_JOBS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  engine.stdout.on("data", value => process.stdout.write(`[engine] ${value}`));
  engine.stderr.on("data", value => process.stderr.write(`[engine] ${value}`));
  engine.on("exit", code => { console.error(`Local engine stopped (${code}); sẽ khởi động lại ở vòng poll kế tiếp.`); engine = null; });
}

async function engineJson(pathname, payload) {
  return requestJson(`${localOrigin}${pathname}`, { method: "POST", body: JSON.stringify(payload) });
}

async function imageDataUrl(filename) {
  const response = await fetch(`${localOrigin}/generated/${encodeURIComponent(filename)}`);
  if (!response.ok) throw new Error(`Không tải được ảnh ${filename} từ local engine.`);
  const contentType = response.headers.get("content-type") || "image/png";
  return dataUrlFromBuffer(await response.arrayBuffer(), contentType);
}

async function localAuthStatus() {
  try {
    const data = await requestJson(`${localOrigin}/api/openai-check`, { method: "GET", headers: {} });
    return data.authenticated === true;
  } catch { return false; }
}

async function pollCentral(authenticated) {
  return requestJson(`${centralOrigin}/internal/helpers/poll`, {
    method: "POST", headers: { "x-helper-token": token },
    body: JSON.stringify({ helperId, authenticated })
  });
}

async function sendResult(jobId, body) {
  return requestJson(`${centralOrigin}/internal/helpers/result`, {
    method: "POST", headers: { "x-helper-token": token }, body: JSON.stringify({ jobId, ...body })
  });
}

async function sendProgress(jobId, body) {
  return requestJson(`${centralOrigin}/internal/helpers/progress`, {
    method: "POST", headers: { "x-helper-token": token }, body: JSON.stringify({ jobId, ...body })
  });
}

async function evaluateProduct(job, product) {
  let evaluation = product.evaluation;
  let selectedModel = product.selectedModel;
  if (!evaluation) {
    await sendProgress(job.id, { productId: product.id, status: "EVALUATING", jobStatus: "EVALUATING", message: "AI đang đánh giá chất lượng ảnh và độ phù hợp..." });
    const evaluated = await engineJson("/api/evaluate", { productImages: product.productImages, modelImages: job.modelImages });
    const candidate = selectCandidate(evaluated);
    if (!candidate) throw new Error("Evaluator không trả về ứng viên model.");
    evaluation = candidate.evaluation;
    selectedModel = candidate.index;
    await sendProgress(job.id, { productId: product.id, status: "EVALUATED", jobStatus: "EVALUATED", evaluation, selectedModel, message: "Đã đánh giá xong; chờ anh duyệt tạo ảnh." });
    await sleep(Number(process.env.STUDIO_EVALUATION_PREVIEW_MS || 1200));
  }
  return { id: product.id, name: product.name, evaluation, selectedModel };
}

async function renderProduct(job, product) {
  const retrying = (job.retryRequests || []).includes(product.id);
  const evaluated = await evaluateProduct(job, product);
  const { evaluation, selectedModel } = evaluated;
  const modelImage = job.modelImages[selectedModel ?? 0];
  if (!modelImage) throw new Error("Không tìm thấy ảnh model được chọn.");
  await sendProgress(job.id, { productId: product.id, status: "RENDERING", jobStatus: "RENDERING", evaluation, selectedModel, message: "Đang tạo ảnh bằng model đã chọn..." });
  const retry = retryInstructions(product);
  const rendered = await engineJson("/api/render", {
    modelImage, productImages: product.productImages, evaluation, skipEvaluation: false, manualOverride: false,
    productId: product.name, quality: "medium", size: "1024x1536", attempt: retrying ? retry.attempt : 1,
    rerenderReasons: retrying ? retry.rerenderReasons : [], rerenderKeep: retrying ? retry.rerenderKeep : []
  });
  const generatedImage = await imageDataUrl(rendered.filename);
  await sendProgress(job.id, { productId: product.id, status: "QC", jobStatus: "QC", evaluation, selectedModel, message: "Đang kiểm tra chất lượng ảnh kết quả..." });
  const qc = await engineJson("/api/qc", { modelImage, productImages: product.productImages, generatedImage });
  return { ...evaluated, output: { dataUrl: generatedImage, filename: rendered.filename }, qc };
}

async function processEvaluationJob(job) {
  const products = [];
  for (const product of job.products || []) {
    try { products.push(await evaluateProduct(job, product)); }
    catch (error) { products.push({ id: product.id, name: product.name, error: error.message, retryable: isRetryableError(error) }); }
  }
  const failed = products.some(product => product.error);
  await sendResult(job.id, { status: failed ? "FAILED" : "AWAITING_EVALUATION_APPROVAL", products });
}

async function processRenderJob(job) {
  const products = [];
  const requested = new Set([...(job.renderRequests || []), ...(job.retryRequests || [])]);
  for (const product of job.products || []) {
    if (requested.size && !requested.has(product.id)) continue;
    try { products.push(await renderProduct(job, product)); }
    catch (error) { products.push({ id: product.id, name: product.name, error: error.message, retryable: isRetryableError(error) }); }
  }
  const failed = products.some(product => product.error);
  await sendResult(job.id, { status: failed ? "FAILED" : "DONE", products });
}

async function processJob(job) {
  if ((job.renderRequests || []).length || (job.retryRequests || []).length) return processRenderJob(job);
  return processEvaluationJob(job);
}

async function loop() {
  startEngine();
  const status = await waitForEngine();
  const authenticated = await localAuthStatus();
  const response = await pollCentral(authenticated);
  if (response.job && authenticated) {
    console.log(`Nhận job ${response.job.id}`);
    await processJob(response.job);
  } else if (response.job && !authenticated) {
    console.warn("Có job nhưng Codex chưa đăng nhập; helper sẽ thử lại sau.");
    await sendResult(response.job.id, { status: "FAILED", products: response.job.products.map(product => ({ id: product.id, error: "Helper chưa đăng nhập Codex/ChatGPT trên máy này.", retryable: true })) });
  }
  return status;
}

async function main() {
  console.log(`Studio Flow helper ${helperId}`);
  console.log(`Central: ${centralOrigin}`);
  console.log("Helper không gửi credential ChatGPT về central server.");
  while (true) {
    try { await loop(); }
    catch (error) { console.error(`[helper] ${error.message}`); }
    await sleep(Number(process.env.STUDIO_HELPER_POLL_MS || 2000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { evaluateProduct, renderProduct, processJob, localAuthStatus };
