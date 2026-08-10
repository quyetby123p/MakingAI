import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.STUDIO_PORT || 4173);
const apiKey = process.env.OPENAI_API_KEY;
const maxBody = 45 * 1024 * 1024;
const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-5.4-mini";
const allowManualOverride = process.env.ALLOW_MANUAL_OVERRIDE !== "false";
const serverId = Date.now().toString(36);

// "codex" = chạy trong hạn mức gói ChatGPT (không tốn API credit). "api" = đường cũ, dùng OPENAI_API_KEY.
const backend = (process.env.STUDIO_BACKEND || "codex").toLowerCase() === "api" ? "api" : "codex";
const evaluatorLabel = backend === "codex" ? "gói ChatGPT qua Codex" : visionModel;
const jobsRoot = path.join(root, ".codex-jobs");
const keepJobs = process.env.STUDIO_KEEP_JOBS === "true";

function findCodex() {
  const explicit = process.env.CODEX_CLI_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const home = os.homedir();
  const exe = process.platform === "win32" ? "codex.exe" : "codex";

  // The desktop app keeps a hashed version folder, so pick the newest build.
  const hashed = process.platform === "win32"
    ? path.join(home, "AppData", "Local", "OpenAI", "Codex", "bin")
    : path.join(home, ".local", "share", "OpenAI", "Codex", "bin");
  if (fs.existsSync(hashed)) {
    const found = fs.readdirSync(hashed)
      .map(dir => path.join(hashed, dir, exe))
      .filter(file => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (found[0]) return found[0];
  }

  // Standalone installs: common locations, then anything already on PATH.
  const plain = [
    path.join(home, ".codex", "bin", exe),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex"
  ];
  for (const file of plain) if (fs.existsSync(file)) return file;

  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, exe);
    try { if (fs.existsSync(file)) return file; } catch { /* unreadable PATH entry */ }
  }
  return null;
}

// Chạy codex exec trong một thư mục job riêng. Agent ghi kết quả ra file, không parse stdout.
function codexExec(prompt, workdir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const bin = findCodex();
    if (!bin) return reject(Object.assign(new Error("Không tìm thấy codex.exe. Cài ChatGPT/Codex hoặc đặt CODEX_CLI_PATH."), { status: 503 }));
    const child = spawn(bin, ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", workdir, prompt], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let out = "", err = "", settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(Object.assign(new Error(`Codex quá thời gian ${Math.round(timeoutMs / 1000)}s.`), { status: 504 }));
    }, timeoutMs);
    child.stdout.on("data", data => { out += data.toString(); });
    child.stderr.on("data", data => { err += data.toString(); });
    child.on("error", error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(`Codex thoát với mã ${code}. ${(err || out).slice(-400)}`), { status: 502 }));
    });
  });
}

function newJobDir(kind) {
  const dir = path.join(jobsRoot, `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupJob(dir) {
  if (keepJobs) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* bỏ qua */ }
}

// Ghi dataURL ra file thật để codex đọc được bằng view_image.
function writeDataUrl(dir, name, dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) throw new Error("Ảnh đầu vào không hợp lệ.");
  const ext = (match[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
  const file = path.join(dir, `${name}.${ext}`);
  fs.writeFileSync(file, Buffer.from(match[2], "base64"));
  return file;
}

function codexAuthStatus() {
  return new Promise(resolve => {
    const bin = findCodex();
    if (!bin) return resolve({ ok: false, reason: "Không tìm thấy codex.exe." });
    const child = spawn(bin, ["login", "status"], { env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, reason: "codex login status quá thời gian." }); }, 20000);
    child.stdout.on("data", data => { out += data.toString(); });
    child.stderr.on("data", data => { out += data.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, reason: "Không chạy được codex." }); });
    child.on("close", () => {
      clearTimeout(timer);
      const logged = /Logged in/i.test(out);
      resolve({ ok: logged, detail: out.trim().slice(0, 200), reason: logged ? null : "Chưa đăng nhập. Chạy: codex login" });
    });
  });
}

const evaluatorPrompt = `You are a strict visual QC evaluator for fashion garment transfer. IMAGE 1 is MODEL_REFERENCE. Remaining images are PRODUCT_REFERENCE views. Product fidelity is the highest priority. Return JSON only.
Evaluate input quality independently, then compatibility only if model score >=82, product score >=85 and neither has hard_fail.
MODEL components/max: body_visibility 25, sharpness 15, resolution 10, pose_readability 15, occlusion 15, lighting 10, perspective 5, subject_cleanliness 5.
PRODUCT components/max: product_completeness 25, silhouette_readability 20, construction_detail 15, sharpness 10, color_reliability 10, fabric_texture 10, viewpoint_usefulness 5, occlusion 5.
COMPATIBILITY components/max: pose_body_geometry 25, garment_geometry 25, length_coverage 20, viewpoint 15, occlusion 10, camera_perspective 5.
Hard fail model for missing critical body region, cropped lower garment/heel/floor for floor-length, severe occlusion, unreadable geometry, unusable quality or ambiguous subject. Hard fail product for missing critical garment region, unreadable silhouette/length/design, severe occlusion or insufficient identity detail. Cap compatibility at 69 for critical missing geometry, insufficient viewpoint, critical occlusion or substantial invention.
Return keys: input_quality.model (all components, hard_fail, hard_fail_reasons), input_quality.product (all components, hard_fail, hard_fail_reasons), compatibility (all components, score_cap_applied, score_cap_reason), risks array of {factor,severity,reason}, recommended_reference_requirements array, product_spec object with category,color,silhouette,neckline,shoulder_structure,bodice,waist,skirt,length,fabric,must_preserve array, model_spec object with pose,body_visibility,camera,composition,lighting,background. Do not provide totals; backend computes them.`;

function clampScore(value, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; }
function sumFields(obj, spec) { return Object.entries(spec).reduce((sum, [key, max]) => sum + clampScore(obj?.[key], max), 0); }
function fiveLevel(score) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  if (value >= 90) return { level: "Xuất sắc", level_code: "EXCELLENT", recommended_action: "Tạo ảnh ngay" };
  if (value >= 82) return { level: "Tốt", level_code: "GOOD", recommended_action: "Tạo ảnh ngay" };
  if (value >= 72) return { level: "Có thể thử", level_code: "TRY", recommended_action: "Render thử và kiểm tra kỹ" };
  if (value >= 60) return { level: "Rủi ro cao", level_code: "RISKY", recommended_action: "Bổ sung hoặc đổi ảnh tham chiếu" };
  return { level: "Không phù hợp", level_code: "UNSUITABLE", recommended_action: "Chọn ảnh khác" };
}
function normalizeEvaluation(raw) {
  const model = raw?.input_quality?.model || {}, product = raw?.input_quality?.product || {}, comp = raw?.compatibility || {};
  const modelScore = sumFields(model,{body_visibility:25,sharpness:15,resolution:10,pose_readability:15,occlusion:15,lighting:10,perspective:5,subject_cleanliness:5});
  const productScore = sumFields(product,{product_completeness:25,silhouette_readability:20,construction_detail:15,sharpness:10,color_reliability:10,fabric_texture:10,viewpoint_usefulness:5,occlusion:5});
  const inputPass = modelScore>=82 && productScore>=85 && !model.hard_fail && !product.hard_fail;
  const rawScore = inputPass ? sumFields(comp,{pose_body_geometry:25,garment_geometry:25,length_coverage:20,viewpoint:15,occlusion:10,camera_perspective:5}) : 0;
  const finalScore = comp.score_cap_applied ? Math.min(rawScore,69) : rawScore;
  const readinessScore = Math.min(modelScore,productScore);
  return {...raw,input_quality:{...raw.input_quality,model:{...model,score:modelScore,...fiveLevel(modelScore)},product:{...product,score:productScore,...fiveLevel(productScore)},input_readiness_score:readinessScore,...fiveLevel(readinessScore),decision:inputPass?'PASS':'REJECT'},compatibility:{...comp,evaluated:inputPass,raw_score:rawScore,final_score:finalScore,...fiveLevel(finalScore),decision:inputPass&&finalScore>=82?'AUTO_RENDER':'REJECT'}};
}

function defaultLabel(index) {
  return index === 0 ? "IMAGE 1 — MODEL_REFERENCE" : `PRODUCT_REFERENCE VIEW ${index}`;
}

async function visionJsonViaApi(prompt, images, labels = []) {
  if (!apiKey) throw Object.assign(new Error("Chưa có OPENAI_API_KEY."), {status:503});
  const content=[{type:"text",text:prompt}];
  images.forEach((image,index)=>{content.push({type:"text",text:labels[index]||defaultLabel(index)});content.push({type:"image_url",image_url:{url:image,detail:"high"}})});
  const response=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{authorization:`Bearer ${apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:evaluatorLabel,messages:[{role:"user",content}],response_format:{type:"json_object"}})});
  const result=await response.json().catch(()=>({}));
  if(!response.ok) throw Object.assign(new Error(result?.error?.message||`Vision API lỗi ${response.status}`),{status:response.status});
  try{return JSON.parse(result.choices?.[0]?.message?.content||"{}")}catch{throw new Error("Evaluator trả JSON không hợp lệ.")}
}

// Chạy cùng prompt đánh giá qua codex exec: agent xem ảnh bằng view_image rồi ghi JSON ra file.
async function visionJsonViaCodex(prompt, images, labels = []) {
  const dir = newJobDir("eval");
  try {
    const files = images.map((image, index) => ({
      label: labels[index] || defaultLabel(index),
      file: writeDataUrl(dir, `img-${String(index + 1).padStart(2, "0")}`, image)
    }));
    const manifest = files.map((item, index) => `${index + 1}. ${path.basename(item.file)} = ${item.label}`).join("\n");
    const instruction = [
      "You are running a strict image evaluation task. Do not write, run or generate any code, and do not generate any images.",
      "",
      "Step 1 — Inspect every image below with the view_image tool, in this exact order:",
      manifest,
      "",
      "Step 2 — Apply the following evaluator specification to those images:",
      "<<<EVALUATOR_SPEC",
      prompt,
      "EVALUATOR_SPEC",
      "",
      "Step 3 — Write your answer as a single raw JSON object to the file `result.json` in the current working directory.",
      "The file must contain only the JSON object: no markdown fences, no commentary, no leading or trailing text.",
      "Do not print the JSON in your reply; the file is the deliverable."
    ].join("\n");
    await codexExec(instruction, dir, Number(process.env.STUDIO_EVAL_TIMEOUT_MS || 360000));
    const resultFile = path.join(dir, "result.json");
    if (!fs.existsSync(resultFile)) throw Object.assign(new Error("Codex không tạo result.json."), { status: 502 });
    const text = fs.readFileSync(resultFile, "utf8").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(text); }
    catch { throw new Error("Evaluator trả JSON không hợp lệ."); }
  } finally {
    cleanupJob(dir);
  }
}

async function visionJson(prompt, images, labels = []) {
  return backend === "codex"
    ? visionJsonViaCodex(prompt, images, labels)
    : visionJsonViaApi(prompt, images, labels);
}

async function evaluateCandidates(payload) {
  if(!Array.isArray(payload.modelImages)||!payload.modelImages.length||!Array.isArray(payload.productImages)||!payload.productImages.length) throw Object.assign(new Error("Thiếu ảnh model hoặc product."),{status:400});
  const candidates=[];
  for(let i=0;i<Math.min(payload.modelImages.length,10);i++){
    const raw=await visionJson(evaluatorPrompt,[payload.modelImages[i],...payload.productImages.slice(0,8)]);
    candidates.push({index:i,evaluation:normalizeEvaluation(raw)});
  }
  candidates.sort((a,b)=>b.evaluation.compatibility.final_score-a.evaluation.compatibility.final_score||b.evaluation.input_quality.input_readiness_score-a.evaluation.input_quality.input_readiness_score);
  return {model:evaluatorLabel,candidates,recommended_index:candidates.find(x=>x.evaluation.compatibility.decision==="AUTO_RENDER")?.index??null};
}

function buildRenderPrompt(e) {
  const p=e.product_spec||{},m=e.model_spec||{},risks=(e.risks||[]).map(x=>`${x.factor}: ${x.reason}`).join("; ");
  return `Create a photorealistic fashion garment-transfer image. FIRST image is the model/base. Preserve exact person, face, hair, pose, body proportions, camera, framing, background and lighting. Remaining images are authoritative product references. Replace only clothing with the exact product. PRODUCT SPEC: category=${p.category||"unknown"}; color=${p.color||"as reference"}; silhouette=${p.silhouette||"as reference"}; neckline=${p.neckline||"as reference"}; shoulder=${p.shoulder_structure||"as reference"}; bodice=${JSON.stringify(p.bodice||{})}; waist=${JSON.stringify(p.waist||{})}; skirt=${JSON.stringify(p.skirt||{})}; length=${JSON.stringify(p.length||{})}; fabric=${JSON.stringify(p.fabric||{})}; must preserve=${(p.must_preserve||[]).join(", ")}. MODEL SPEC: ${JSON.stringify(m)}. RISKS: ${risks||"none"}. Do not redesign, simplify, embellish, combine garments, invent seams/details, alter neckline, length, volume, color or material. Preserve correct heel/floor relationship and fit naturally.`;
}

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    res.end(body);
  } else {
    res.end(JSON.stringify(body));
  }
};

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) throw new Error("Ảnh đầu vào không hợp lệ.");
  return { type: match[1], blob: new Blob([Buffer.from(match[2], "base64")], { type: match[1] }) };
}

function assertRenderPayload(payload) {
  if (!payload.modelImage || !Array.isArray(payload.productImages) || !payload.productImages.length) {
    throw Object.assign(new Error("Cần ít nhất một ảnh người mẫu và một ảnh sản phẩm."), { status: 400 });
  }
  if (!payload.evaluation || (payload.evaluation.compatibility?.decision !== "AUTO_RENDER" && !(allowManualOverride && payload.manualOverride === true))) {
    throw Object.assign(new Error("Input chưa vượt Input Gate và Compatibility Gate."), { status: 422 });
  }
}

function saveGenerated(payload, buffer) {
  const generatedDir = path.join(root, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });
  const safeId = String(payload.productId || "studio-flow").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "studio-flow";
  const filename = `${safeId}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const savedPath = path.join(generatedDir, filename);
  fs.writeFileSync(savedPath, buffer);
  return { filename, savedPath };
}

function composeRenderPrompt(payload) {
  const basePrompt = payload.prompt || buildRenderPrompt(payload.evaluation) || [
    "Create a photorealistic fashion studio image.",
    "The FIRST image is the model/base image. Preserve the exact same person, face, identity, body proportions, pose, camera, crop, lighting and background.",
    "The remaining images are product references. Replace only the model's current garment with the exact referenced product.",
    "Preserve product color, material, silhouette, neckline, sleeves, waist construction, hem length, seams, pattern, logos and hardware as faithfully as visible in the references.",
    "Keep hands, hair and accessories natural. Do not add text, change the face, reshape the body, or invent product details not supported by references."
  ].join(" ");
  const rerenderReasons = Array.isArray(payload.rerenderReasons) ? payload.rerenderReasons.filter(Boolean).slice(0, 8) : [];
  const rerenderGuidance = Number(payload.attempt) > 1
    ? ` This is alternative attempt ${Number(payload.attempt)}. Produce a genuinely new variation while preserving the same person and authoritative product references. Correct these issues from the previous attempt: ${rerenderReasons.join("; ") || "improve product fidelity, garment construction, fit and realism"}.`
    : "";
  return `${basePrompt}${rerenderGuidance}`;
}

async function renderImageViaApi(payload) {
  if (!apiKey) throw Object.assign(new Error("Chưa có OPENAI_API_KEY. Hãy đóng cửa sổ server, thiết lập key rồi chạy lại."), { status: 503 });

  const form = new FormData();
  form.append("model", "gpt-image-2");
  form.append("quality", payload.quality || "medium");
  form.append("size", payload.size || "1024x1536");
  form.append("output_format", "png");
  form.append("prompt", composeRenderPrompt(payload));

  const model = dataUrlToBlob(payload.modelImage);
  form.append("image[]", model.blob, `model.${model.type.split("/")[1] || "png"}`);
  payload.productImages.slice(0, 8).forEach((data, index) => {
    const item = dataUrlToBlob(data);
    form.append("image[]", item.blob, `product-${index + 1}.${item.type.split("/")[1] || "png"}`);
  });

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result?.error?.message || `OpenAI API trả lỗi ${response.status}.`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) throw new Error("API không trả về dữ liệu ảnh.");
  const { filename, savedPath } = saveGenerated(payload, Buffer.from(b64, "base64"));
  return { image: `data:image/png;base64,${b64}`, usage: result.usage || null, model: "gpt-image-2", filename, savedPath, backend: "api" };
}

// Ghép đồ qua codex exec: chạy trong hạn mức gói ChatGPT, không tốn API credit.
async function renderImageViaCodex(payload) {
  const dir = newJobDir("render");
  try {
    const modelFile = writeDataUrl(dir, "model", payload.modelImage);
    const productFiles = payload.productImages.slice(0, 8).map((data, index) => writeDataUrl(dir, `product-${index + 1}`, data));
    const size = payload.size || "1024x1536";
    const quality = payload.quality || "medium";
    const instruction = [
      "You are performing a fashion garment-transfer image edit. Use the built-in image_gen tool. Do not write or run any Python, Node or shell image code, and do not use the CLI fallback.",
      "",
      "Step 1 — Load every input image into context with the view_image tool, in this order:",
      `1. ${path.basename(modelFile)} = MODEL_REFERENCE (the base image to preserve)`,
      ...productFiles.map((file, index) => `${index + 2}. ${path.basename(file)} = PRODUCT_REFERENCE VIEW ${index + 1} (authoritative garment source)`),
      "",
      "Step 2 — Run one built-in image_gen edit using the model image as the edit target and the product images as authoritative references. Apply this specification exactly:",
      "<<<RENDER_SPEC",
      composeRenderPrompt(payload),
      "RENDER_SPEC",
      "",
      `Target output: approximately ${size} pixels, portrait orientation preserved, ${quality} quality, PNG.`,
      "",
      "Step 3 — Copy the generated PNG to the file `output.png` in the current working directory.",
      "Produce exactly one image. Do not create variants, do not ask questions, and do not stop before output.png exists."
    ].join("\n");
    await codexExec(instruction, dir, Number(process.env.STUDIO_RENDER_TIMEOUT_MS || 600000));
    const outputFile = path.join(dir, "output.png");
    if (!fs.existsSync(outputFile)) throw Object.assign(new Error("Codex không tạo output.png. Thử lại hoặc đổi STUDIO_BACKEND=api."), { status: 502 });
    const buffer = fs.readFileSync(outputFile);
    const { filename, savedPath } = saveGenerated(payload, buffer);
    return { image: `data:image/png;base64,${buffer.toString("base64")}`, usage: null, model: "gpt-image-2 (gói ChatGPT qua Codex)", filename, savedPath, backend: "codex" };
  } finally {
    cleanupJob(dir);
  }
}

async function renderImage(payload) {
  assertRenderPayload(payload);
  return backend === "codex" ? renderImageViaCodex(payload) : renderImageViaApi(payload);
}

async function qcOutput(payload){
  const productReferences=(Array.isArray(payload.productImages)?payload.productImages:[payload.productImage]).filter(Boolean).slice(0,8);
  if(!payload.modelImage||!productReferences.length||!payload.generatedImage) throw Object.assign(new Error("Thiếu ảnh để chạy output QC."),{status:400});
  const images=[payload.modelImage,...productReferences,payload.generatedImage];
  const labels=["ORIGINAL MODEL REFERENCE",...productReferences.map((_,index)=>`PRODUCT REFERENCE VIEW ${index+1}`),"FINAL GENERATED OUTPUT TO JUDGE"];
  const prompt=`You are a strict post-render fashion product fidelity judge. The labeled images contain one ORIGINAL MODEL REFERENCE, one or more PRODUCT REFERENCE VIEW images, and exactly one FINAL GENERATED OUTPUT TO JUDGE. Judge only the final generated output against all references. Return JSON only with numeric fields: silhouette 0-25, construction_detail 0-25, length_proportion 0-15, color_material 0-15, model_pose_preservation 0-10, scene_camera_preservation 0-10; critical_failure boolean; critical_failure_reasons array; rerender_reasons array. Product fidelity is primary. Critical failures include wrong neckline/bodice, silhouette, length, invented/missing distinctive detail, or major color/material deviation.`;
  const raw=await visionJson(prompt,images,labels);
  const score=sumFields(raw,{silhouette:25,construction_detail:25,length_proportion:15,color_material:15,model_pose_preservation:10,scene_camera_preservation:10});
  return {...raw,product_fidelity_score:score,...fiveLevel(score),decision:score>=88&&!raw.critical_failure?'PASS':'RERENDER',model:evaluatorLabel};
}

async function checkOpenAIKey() {
  if (backend === "codex") {
    const status = await codexAuthStatus();
    if (!status.ok) throw Object.assign(new Error(status.reason || "Codex chưa đăng nhập."), { status: 503 });
    return { ok: true, authenticated: true, backend: "codex", detail: status.detail };
  }
  if (!apiKey) throw Object.assign(new Error("Chưa có OPENAI_API_KEY."), { status: 503 });
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(result?.error?.message || `OpenAI API trả lỗi ${response.status}.`), { status: response.status });
  }
  return { ok: true, authenticated: true };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/status") {
    const ready = backend === "codex" ? Boolean(findCodex()) : Boolean(apiKey);
    return send(res, 200, { ready, backend, model: "gpt-image-2", evaluator: backend === "codex" ? "gói ChatGPT qua Codex" : visionModel, allowManualOverride, serverId });
  }
  if (req.method === "GET" && req.url === "/api/openai-check") {
    try { return send(res, 200, await checkOpenAIKey()); }
    catch (error) { return send(res, error.status || 500, { error: error.message || "Không thể xác thực API key." }); }
  }
  if (req.method === "POST" && req.url === "/api/render") {
    let size = 0, chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBody) req.destroy(); else chunks.push(chunk);
    });
    req.on("end", async () => {
      try { send(res, 200, await renderImage(JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
      catch (error) { send(res, error.status || 500, { error: error.message || "Không thể tạo ảnh." }); }
    });
    return;
  }
  if (req.method === "POST" && (req.url === "/api/evaluate" || req.url === "/api/qc")) {
    let size=0,chunks=[];
    req.on("data",chunk=>{size+=chunk.length;if(size>maxBody)req.destroy();else chunks.push(chunk)});
    req.on("end",async()=>{try{const payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));send(res,200,req.url==="/api/evaluate"?await evaluateCandidates(payload):await qcOutput(payload))}catch(error){send(res,error.status||500,{error:error.message||"Evaluation failed"})}});
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/studio-flow-ui.html")) {
    return send(res, 200, fs.readFileSync(path.join(root, "studio-flow-ui.html")), "text/html; charset=utf-8");
  }
  send(res, 404, { error: "Not found" });
});

server.listen(port, "127.0.0.1", async () => {
  console.log(`Studio Flow: http://127.0.0.1:${port}`);
  console.log(`Backend: ${backend === "codex" ? "CODEX (gói ChatGPT — không tốn API credit)" : "API (OPENAI_API_KEY — tính phí)"}`);
  if (backend === "codex") {
    const bin = findCodex();
    console.log(bin ? `Codex CLI: ${bin}` : "Codex CLI: KHÔNG TÌM THẤY — đặt CODEX_CLI_PATH hoặc cài ChatGPT/Codex");
    if (bin) {
      const status = await codexAuthStatus();
      console.log(status.ok ? `Đăng nhập: ${status.detail || "OK"}` : `Đăng nhập: CHƯA — ${status.reason}`);
    }
    console.log("Đổi sang API cũ: đặt STUDIO_BACKEND=api trước khi chạy.");
  } else {
    console.log(apiKey ? "GPT Image 2: READY" : "GPT Image 2: CHƯA CÓ OPENAI_API_KEY");
  }
});
