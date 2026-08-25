import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
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

// Pin the model and reasoning depth per job. Without this we inherit whatever sits
// in ~/.codex/config.toml, which follows whatever the ChatGPT app was last set to —
// and a model the app allows is not always one a ChatGPT account may drive from the
// CLI. Scoring runs up to ten times per product and only applies a fixed rubric, so
// it stays at shallow depth to contain latency. Rendering runs once and is the shot
// that matters, so both paths can use the flagship model without forcing deep reasoning.
// Rendering must use a model that carries the built-in image_gen tool. As of
// 2026-08, only gpt-5.6-sol does, and only on a paid ChatGPT plan — terra, luna and
// 5.5 all report `tools.image_gen is not a function`. Scoring only needs view_image,
// which every model has.
const evalModel = process.env.STUDIO_EVAL_MODEL || "gpt-5.6-sol";
const evalEffort = process.env.STUDIO_EVAL_EFFORT || "low";
const renderModel = process.env.STUDIO_RENDER_MODEL || "gpt-5.6-sol";
const renderEffort = process.env.STUDIO_RENDER_EFFORT || "medium";
const renderCapacityRetries = Math.max(0, Math.min(5, Number(process.env.STUDIO_RENDER_CAPACITY_RETRIES || 3)));
const renderCapacityRetryDelayMs = Math.max(1000, Number(process.env.STUDIO_RENDER_CAPACITY_RETRY_DELAY_MS || 15000));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isCapacityErrorText(value) {
  return /selected model is at capacity|model .*capacity|try a different model/i.test(String(value || ""));
}

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
function codexExec(prompt, workdir, timeoutMs, model, effort) {
  return new Promise((resolve, reject) => {
    const bin = findCodex();
    if (!bin) return reject(Object.assign(new Error("Không tìm thấy codex.exe. Cài ChatGPT/Codex hoặc đặt CODEX_CLI_PATH."), { status: 503 }));
    const child = spawn(bin, ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check",
      "-m", model, "-c", `model_reasoning_effort="${effort}"`, "-C", workdir, prompt], {
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
      else {
        const tail = (err || out).slice(-400);
        reject(Object.assign(new Error(`Codex thoát với mã ${code}. ${tail}`), {
          status: isCapacityErrorText(tail) ? 503 : 502,
          code: isCapacityErrorText(tail) ? "model_at_capacity" : "codex_exec_failed",
          retryable: true
        }));
      }
    });
  });
}

// codex exec can exit cleanly without producing the file we asked for — a missing
// tool, a refusal. The agent always says why in its closing message, so carry that
// into the error instead of leaving the user with a blank "it didn't work".
function lastWords(log) {
  const text = String(log || "").replace(/\r/g, "").trim();
  if (!text) return "";
  const tail = text.split(/\n\s*\n/).filter(Boolean).pop() || "";
  return tail.replace(/\s+/g, " ").trim().slice(-300);
}

const publicModerationMessage = stage => stage === "input"
  ? "OpenAI đã chặn ảnh hoặc mô tả tại bước kiểm tra đầu vào. App không có quyền tắt lớp kiểm tra này; hãy đổi ảnh đầu vào hoặc dùng một dịch vụ tạo ảnh khác phù hợp hơn."
  : stage === "output"
    ? "OpenAI đã chặn kết quả tạo thử ở bước kiểm tra đầu ra. Hệ thống đã dừng và không tự gửi lại cùng một yêu cầu."
    : "OpenAI đã chặn yêu cầu tạo ảnh. App không có quyền tắt lớp kiểm tra này; hãy đổi đầu vào hoặc dùng một dịch vụ tạo ảnh khác phù hợp hơn.";

function moderationError({ stage = "unknown", categories = [], requestId = null } = {}) {
  const safeStage = ["input", "output", "unknown"].includes(stage) ? stage : "unknown";
  const safeCategories = Array.isArray(categories)
    ? categories.map(String).filter(Boolean).slice(0, 4)
    : [];
  const error = Object.assign(new Error(publicModerationMessage(safeStage)), {
    status: 422,
    code: "moderation_blocked",
    type: "image_generation_user_error",
    moderationDetails: { moderation_stage: safeStage, categories: safeCategories },
    retryable: false
  });
  if (requestId) error.requestId = String(requestId);
  return error;
}

function modelCapacityError() {
  return Object.assign(new Error("Model tạo ảnh của ChatGPT đang quá tải. Hệ thống đã tự thử lại nhưng chưa nhận được lượt render; bấm Tạo lại sau ít phút."), {
    status: 503,
    code: "model_at_capacity",
    retryable: true
  });
}

function moderationFromLog(log) {
  const text = String(log || "");
  if (!/(moderation|safety (?:filter|check)|image generation refused|image_gen refuses?)/i.test(text)) return null;
  const categories = ["sexual", "harassment", "self-harm", "violence"].filter(category =>
    new RegExp(category.replace("-", "[- ]"), "i").test(text));
  const stage = /(?:moderation[_ ]stage|stage)\s*[:=]?\s*input/i.test(text)
    ? "input"
    : /(?:moderation[_ ]stage|stage)\s*[:=]?\s*output/i.test(text) ? "output" : "unknown";
  return { stage, categories };
}

function errorResponse(error, fallback) {
  const body = { error: error?.message || fallback };
  if (error?.code) body.code = error.code;
  if (error?.type) body.type = error.type;
  if (error?.moderationDetails) body.moderation_details = error.moderationDetails;
  if (error?.requestId) body.request_id = error.requestId;
  if (typeof error?.retryable === "boolean") body.retryable = error.retryable;
  return body;
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

function recentSessionDirs(sinceMs) {
  const rootDir = process.env.CODEX_SESSION_ROOT || path.join(os.homedir(), ".codex", "sessions");
  const dirs = new Set();
  const end = Date.now() + 24 * 60 * 60 * 1000;
  for (let time = sinceMs - 24 * 60 * 60 * 1000; time <= end; time += 24 * 60 * 60 * 1000) {
    const date = new Date(time);
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    dirs.add(path.join(rootDir, yyyy, mm, dd));
  }
  return [...dirs].filter(dir => {
    try { return fs.existsSync(dir); } catch { return false; }
  });
}

function recentJsonlFiles(dir, sinceMs) {
  const found = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...recentJsonlFiles(file, sinceMs));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const stat = fs.statSync(file);
      if (stat.mtimeMs >= sinceMs - 30 * 60 * 1000) found.push(file);
    }
  } catch {
    // Session files may be locked while Codex writes them; ignore unreadable folders.
  }
  return found;
}

function validImageFile(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1024) return false;
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, head.length, 0);
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const jpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const webp = head.slice(0, 4).toString("ascii") === "RIFF" && head.slice(8, 12).toString("ascii") === "WEBP";
    return png || jpg || webp;
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

async function recoverCodexGeneratedOutput(jobDir, outputFile, startedAtMs) {
  const resolvedJobDir = path.resolve(jobDir);
  const needles = [
    resolvedJobDir,
    resolvedJobDir.replace(/\\/g, "\\\\"),
    path.basename(resolvedJobDir)
  ].filter(Boolean);

  for (const sessionDir of recentSessionDirs(startedAtMs)) {
    for (const file of recentJsonlFiles(sessionDir, startedAtMs)) {
      let mentionsThisJob = false;
      const stream = fs.createReadStream(file, { encoding: "utf8" });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!mentionsThisJob && needles.some(needle => line.includes(needle))) {
            mentionsThisJob = true;
          }
          if (!mentionsThisJob || !line.includes("image_generation_end")) continue;
          let item = null;
          try { item = JSON.parse(line); } catch { continue; }
          const payload = item?.payload || {};
          const savedPath = payload.saved_path || payload.result?.saved_path;
          if (savedPath && validImageFile(savedPath)) {
            fs.copyFileSync(savedPath, outputFile);
            return { recovered: true, source: "codex_saved_path", path: savedPath, session: file };
          }
          if (typeof payload.result === "string" && payload.result.length > 1000) {
            try {
              fs.writeFileSync(outputFile, Buffer.from(payload.result, "base64"));
              if (validImageFile(outputFile)) return { recovered: true, source: "codex_result_base64", session: file };
              fs.rmSync(outputFile, { force: true });
            } catch {
              try { fs.rmSync(outputFile, { force: true }); } catch { /* ignore */ }
            }
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }
  }
  return { recovered: false };
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

// Thresholds live in normalizeEvaluation, never here: a judge that knows the pass
// mark scores towards it. Ranges live in the schema instead of a second component
// list, so the two can never drift apart. model_spec is gone — nothing read it.
const evaluatorPrompt = `# Role
Strict visual QC evaluator for fashion garment transfer. Product fidelity outranks model quality.

# Input
Image 1 is the model. All other images are views of one garment.

# Rules
- Score every field. No totals, levels or decisions — the backend computes them.
- Bands per field, as % of max: 90+ unambiguous · 75-89 one small inference · 55-74 needs guesswork · 30-54 mostly unreadable · under 30 absent or misleading.
- hard_fail: a critical body or garment region is missing, a floor-length hem is cut off, geometry or design is unreadable, or occlusion is severe.
- score_cap_applied: a faithful transfer would need substantial invention.
- product_spec feeds the image prompt directly. Each value is a short, neutral, retail-catalog English phrase, never JSON. Omit what you cannot read; never write "unknown".
- Vietnamese for score_cap_reason, risks[].reason and recommended_reference_requirements. English everywhere else.

# Output
Raw JSON only, integers within the ranges shown:
{"input_quality":{"model":{"body_visibility":<0-25>,"sharpness":<0-15>,"resolution":<0-10>,"pose_readability":<0-15>,"occlusion":<0-15>,"lighting":<0-10>,"perspective":<0-5>,"subject_cleanliness":<0-5>,"hard_fail":<bool>},"product":{"product_completeness":<0-25>,"silhouette_readability":<0-20>,"construction_detail":<0-15>,"sharpness":<0-10>,"color_reliability":<0-10>,"fabric_texture":<0-10>,"viewpoint_usefulness":<0-5>,"occlusion":<0-5>,"hard_fail":<bool>}},"compatibility":{"pose_body_geometry":<0-25>,"garment_geometry":<0-25>,"length_coverage":<0-20>,"viewpoint":<0-15>,"occlusion":<0-10>,"camera_perspective":<0-5>,"score_cap_applied":<bool>,"score_cap_reason":""},"risks":[{"factor":"","reason":""}],"recommended_reference_requirements":[],"product_spec":{"category":"","color":"","silhouette":"","neckline":"","shoulder_structure":"","bodice":"","waist":"","skirt":"","length":"","fabric":"","must_preserve":[]}}`;

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
  const rawScore = sumFields(comp,{pose_body_geometry:25,garment_geometry:25,length_coverage:20,viewpoint:15,occlusion:10,camera_perspective:5});
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
      "Evaluate images. Do not write or run code, and do not generate images.",
      "",
      "1. Inspect every image with view_image, in this order:",
      manifest,
      "",
      "2. Apply this specification:",
      "<evaluator_spec>",
      prompt,
      "</evaluator_spec>",
      "",
      "3. Write the JSON object to `result.json` here: no fences, no commentary. Re-read it to confirm it parses. If an image will not open, still write the file and score it 0.",
      "The file is the deliverable, not your reply."
    ].join("\n");
    const log = await codexExec(instruction, dir, Number(process.env.STUDIO_EVAL_TIMEOUT_MS || 360000), evalModel, evalEffort);
    const resultFile = path.join(dir, "result.json");
    if (!fs.existsSync(resultFile)) {
      const why = lastWords(log);
      throw Object.assign(new Error(`Codex không tạo result.json.${why ? ` Agent nói: ${why}` : ""}`), { status: 502 });
    }
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

// Keep evaluator/QC prose bounded and neutral before it reaches image generation.
// These replacements retain the garment design while avoiding wording that can
// accidentally frame a standard catalogue edit as intimate content.
function cleanFashionPhrase(value) {
  const text = typeof value === "string"
    ? value.trim().replace(/\.$/, "")
      .replace(/[<>`{}]/g, " ")
      .replace(/\b(?:plunging|deep)\s+v(?:-neck)?\b/gi, "v-neck")
      .replace(/\blow[- ]cut\b/gi, "open neckline")
      .replace(/\bcleavage\b/gi, "neckline")
      .replace(/\bnude\b/gi, "beige")
      .replace(/\b(?:see[- ]through|transparent|sheer)\b/gi, "lightweight")
      .replace(/\bskin[- ]tight\b/gi, "close-fitting")
      .replace(/\s+/g, " ").slice(0, 160)
    : "";
  return text && !/^(unknown|as reference|none|n\/a)$/i.test(text) ? text : "";
}

// The image model reads prose, not JSON, and follows positive statements far better
// than a chain of prohibitions. Unreadable fields are dropped instead of being sent
// as "unknown", and model_spec is left out entirely: the base photo is the edit
// target, so describing it again in words can only contradict the pixels.
function buildRenderPrompt(e = {}) {
  const p = e.product_spec || {};
  const garment = [p.category, p.color, p.silhouette, p.neckline, p.shoulder_structure,
    p.bodice, p.waist, p.skirt, p.length, p.fabric].map(cleanFashionPhrase).filter(Boolean).join(", ");
  const keep = (p.must_preserve || []).map(cleanFashionPhrase).filter(Boolean).slice(0, 6).join(", ");
  return [
    "Create a photorealistic commercial fashion catalogue edit featuring the adult model in the FIRST image wearing the referenced product exactly as sold.",
    "Preserve the model's identity, face, hair, pose, hands, camera, framing, background and lighting.",
    "Use the FIRST image only as the edit canvas. Use every remaining image only to read the garment; ignore the identity, pose and styling of any people shown in those references.",
    "Reproduce the referenced garment faithfully, including its fit, fabric drape, panels, trim, colour, length and construction.",
    garment ? `The garment: ${garment}.` : "",
    keep ? `Keep visible: ${keep}.` : "",
    "Take construction details only from the references; where they show nothing, choose the plainest retail-catalog reading. Keep correct hem, heel and floor contact.",
    "Use a neutral, non-suggestive, product-focused presentation suitable for an online retail catalogue."
  ].filter(Boolean).join(" ");
}

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  if (typeof body === "string" || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    res.end(body);
  } else {
    res.end(JSON.stringify(body));
  }
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], tooLarge = false, settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBody) {
        tooLarge = true;
        chunks = [];
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      if (tooLarge) return fail(Object.assign(new Error("Tổng dung lượng ảnh vượt quá giới hạn 45 MB."), {
        status: 413,
        code: "payload_too_large",
        retryable: false
      }));
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        settled = true;
        resolve(payload);
      } catch {
        fail(Object.assign(new Error("Dữ liệu JSON không hợp lệ."), { status: 400, code: "invalid_json", retryable: false }));
      }
    });
    req.on("error", fail);
    req.on("aborted", () => fail(Object.assign(new Error("Kết nối tải ảnh đã bị ngắt."), {
      status: 400,
      code: "request_aborted",
      retryable: true
    })));
  });
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!match) throw new Error("Ảnh đầu vào không hợp lệ.");
  return { type: match[1], blob: new Blob([Buffer.from(match[2], "base64")], { type: match[1] }) };
}

function assertRenderPayload(payload) {
  if (!payload.modelImage || !Array.isArray(payload.productImages) || !payload.productImages.length) {
    throw Object.assign(new Error("Cần ít nhất một ảnh người mẫu và một ảnh sản phẩm."), { status: 400 });
  }
  const skipEvaluation = payload.skipEvaluation === true;
  if (!skipEvaluation && (!payload.evaluation || (payload.evaluation.compatibility?.decision !== "AUTO_RENDER" && !(allowManualOverride && payload.manualOverride === true)))) {
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

function generatedFile(filename) {
  const name = String(filename || "");
  if (!name || path.basename(name) !== name || !/\.png$/i.test(name)) {
    throw Object.assign(new Error("Tên ảnh đã tạo không hợp lệ."), { status: 400 });
  }
  const file = path.join(root, "generated", name);
  if (!fs.existsSync(file)) throw Object.assign(new Error("Không tìm thấy ảnh đã tạo."), { status: 404 });
  return file;
}

const generatedUrl = filename => `/generated/${encodeURIComponent(filename)}`;

// A retry is a correction, not a fresh take: naming what already matched stops the
// next attempt from fixing the hem and breaking the neckline. The render prompt is
// always server-built so clients cannot bypass the catalogue safety framing.
function composeRenderPrompt(payload) {
  const basePrompt = buildRenderPrompt(payload.evaluation || {});
  if (Number(payload.attempt) <= 1) return basePrompt;

  const list = key => (Array.isArray(payload[key])
    ? payload[key].map(cleanFashionPhrase).filter(Boolean).slice(0, 4)
    : []);
  const keep = list("rerenderKeep");
  const fixes = list("rerenderReasons");
  const guidance = [
    ` Revision ${Number(payload.attempt)}.`,
    " This must be a newly generated corrected revision from the original model canvas and garment references, not a reuse or near-duplicate of an earlier generated result.",
    keep.length ? ` Already correct, keep unchanged: ${keep.join(", ")}.` : "",
    fixes.length
      ? ` Change only this: ${fixes.join("; ")}.`
      : " Bring the garment closer to the references.",
    " Preserve the original model photo and product identity, but visibly re-evaluate garment placement, fit and drape for this revision."
  ].filter(Boolean).join("");
  return `${basePrompt}${guidance}`;
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
    const problem = result?.error || {};
    const requestId = response.headers.get("x-request-id") || problem.request_id || null;
    if (problem.code === "moderation_blocked") {
      throw moderationError({
        stage: problem.moderation_details?.moderation_stage,
        categories: problem.moderation_details?.categories,
        requestId
      });
    }
    throw Object.assign(new Error(problem.message || `OpenAI API trả lỗi ${response.status}.`), {
      status: response.status,
      code: problem.code || problem.type || null,
      type: problem.type || null,
      requestId,
      retryable: response.status === 429 || response.status >= 500
    });
  }
  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) throw new Error("API không trả về dữ liệu ảnh.");
  const { filename, savedPath } = saveGenerated(payload, Buffer.from(b64, "base64"));
  return { imageUrl: generatedUrl(filename), usage: result.usage || null, model: "gpt-image-2", filename, savedPath, backend: "api" };
}

// Ghép đồ qua codex exec: chạy trong hạn mức gói ChatGPT, không tốn API credit.
async function renderImageViaCodex(payload) {
  const dir = newJobDir("render");
  try {
    const modelFile = writeDataUrl(dir, "model", payload.modelImage);
    const productFiles = payload.productImages.slice(0, 8).map((data, index) => writeDataUrl(dir, `product-${index + 1}`, data));
    const size = payload.size || "1024x1536";
    const quality = payload.quality || "medium";
    const outputFile = path.join(dir, "output.png");
    const instruction = [
      "Edit a fashion photograph with the built-in image_gen tool. Do not write or run image-generation code. Use the image_gen tool for the image itself.",
      "",
      "1. Load every image with view_image, in this order:",
      `1. ${path.basename(modelFile)} = model, the base image to preserve`,
      ...productFiles.map((file, index) => `${index + 2}. ${path.basename(file)} = garment view ${index + 1}`),
      "",
      "2. Run exactly one image_gen edit: the model image is the target, the garment images are references. Apply this specification:",
      "<render_spec>",
      composeRenderPrompt(payload),
      "</render_spec>",
      `Target roughly ${size}, portrait, ${quality} quality, PNG.`,
      "",
      `3. Save/export or copy the final image to this exact file path: ${outputFile}`,
      "If image_gen returns a managed `saved_path`, copy that file to the exact output path above. If copying is not available, include the exact saved_path in your final message. One image, no variants, no questions.",
      "If image_gen is blocked or refuses, do not retry the same request. Write `failure.json` with raw JSON shaped as {\"code\":\"moderation_blocked\",\"moderation_stage\":\"input|output|unknown\",\"categories\":[]} using details returned by the tool when available, then stop."
    ].join("\n");
    let log = "";
    let renderStartedAtMs = Date.now();
    for (let attempt = 0; attempt <= renderCapacityRetries; attempt += 1) {
      try {
        renderStartedAtMs = Date.now();
        log = await codexExec(instruction, dir, Number(process.env.STUDIO_RENDER_TIMEOUT_MS || 600000), renderModel, renderEffort);
        break;
      } catch (error) {
        if (error.code === "model_at_capacity" && attempt < renderCapacityRetries) {
          await sleep(renderCapacityRetryDelayMs * (attempt + 1));
          continue;
        }
        if (error.code === "model_at_capacity") throw modelCapacityError();
        throw error;
      }
    }
    if (!fs.existsSync(outputFile)) {
      const recovered = await recoverCodexGeneratedOutput(dir, outputFile, renderStartedAtMs);
      if (recovered.recovered) {
        console.warn(`Recovered Codex generated image for ${path.basename(dir)} from ${recovered.source}.`);
      }
    }
    if (!fs.existsSync(outputFile)) {
      const failureFile = path.join(dir, "failure.json");
      if (fs.existsSync(failureFile)) {
        try {
          const failure = JSON.parse(fs.readFileSync(failureFile, "utf8"));
          if (failure?.code === "moderation_blocked") {
            throw moderationError({ stage: failure.moderation_stage, categories: failure.categories });
          }
        } catch (error) {
          if (error?.code === "moderation_blocked") throw error;
          // A malformed failure marker falls through to log classification.
        }
      }
      const blocked = moderationFromLog(log);
      if (blocked) throw moderationError(blocked);
      if (isCapacityErrorText(log)) throw modelCapacityError();
      const why = lastWords(log);
      const detail = /managed output directory|saved_path|did not honor the requested workspace path|copy operation/i.test(why)
        ? "Codex đã tạo ảnh nhưng chưa trả file về đúng thư mục. Hệ thống chưa tìm thấy file managed để thu hồi; bấm Duyệt tạo ảnh/Tạo lại sau ít phút."
        : `Codex không tạo được ảnh đầu ra.${why ? ` Chi tiết: ${why}` : ""}`;
      throw Object.assign(new Error(detail), { status: 502, code: "codex_output_missing", retryable: true });
    }
    const buffer = fs.readFileSync(outputFile);
    const { filename, savedPath } = saveGenerated(payload, buffer);
    return { imageUrl: generatedUrl(filename), usage: null, model: "gpt-image-2 (gói ChatGPT qua Codex)", filename, savedPath, backend: "codex" };
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
  const generatedImage=payload.generatedImage||(payload.generatedFilename
    ? `data:image/png;base64,${fs.readFileSync(generatedFile(payload.generatedFilename)).toString("base64")}`
    : "");
  if(!payload.modelImage||!productReferences.length||!generatedImage) throw Object.assign(new Error("Thiếu ảnh để chạy output QC."),{status:400});
  const images=[payload.modelImage,...productReferences,generatedImage];
  const labels=["ORIGINAL MODEL REFERENCE",...productReferences.map((_,index)=>`PRODUCT REFERENCE VIEW ${index+1}`),"FINAL GENERATED OUTPUT TO JUDGE"];
  const prompt=`# Role
Strict fidelity judge for fashion garment transfer.

# Input
Labelled: one model reference, one or more garment reference views, and exactly one generated output.

# Rules
- Judge only the generated output, against the references. Product fidelity is primary.
- Score every field. No total, no pass/fail — the backend computes them.
- Bands per field, as % of max: 90+ indistinguishable · 75-89 a buyer accepts it · 55-74 visibly off, same garment · 30-54 different garment, same family · under 30 unrelated.
- critical_failure: wrong neckline, bodice, silhouette or length; a distinctive detail invented or lost; major colour or material deviation.
- strengths: up to 4 garment features already correct. They are fed to the next attempt to protect them.
- rerender_reasons: up to 4 corrections, each written as the change to make — "shorten the hem to mid-calf", not "the hem is too long".
- rerender_notes_vi: the same points in Vietnamese. English everywhere else.

# Output
Raw JSON only, integers within the ranges shown:
{"silhouette":<0-25>,"construction_detail":<0-25>,"length_proportion":<0-15>,"color_material":<0-15>,"model_pose_preservation":<0-10>,"scene_camera_preservation":<0-10>,"critical_failure":<bool>,"strengths":[],"rerender_reasons":[],"rerender_notes_vi":[]}`;
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
  if (req.method === "GET" && req.url?.startsWith("/generated/")) {
    try {
      const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
      const filename = decodeURIComponent(pathname.slice("/generated/".length));
      return send(res, 200, fs.readFileSync(generatedFile(filename)), "image/png");
    } catch (error) {
      return send(res, error.status || 404, errorResponse(error, "Không tìm thấy ảnh."));
    }
  }
  if (req.method === "GET" && req.url === "/api/status") {
    const ready = backend === "codex" ? Boolean(findCodex()) : Boolean(apiKey);
    return send(res, 200, { ready, backend, model: "gpt-image-2", evaluator: backend === "codex" ? "gói ChatGPT qua Codex" : visionModel,
      evaluatorModel: backend === "codex" ? evalModel : visionModel, evaluatorEffort: backend === "codex" ? evalEffort : null,
      allowManualOverride, serverId });
  }
  if (req.method === "GET" && req.url === "/api/openai-check") {
    try { return send(res, 200, await checkOpenAIKey()); }
    catch (error) { return send(res, error.status || 500, errorResponse(error, "Không thể xác thực API key.")); }
  }
  if (req.method === "POST" && req.url === "/api/render") {
    try { send(res, 200, await renderImage(await readJsonBody(req))); }
    catch (error) { send(res, error.status || 500, errorResponse(error, "Không thể tạo ảnh.")); }
    return;
  }
  if (req.method === "POST" && (req.url === "/api/evaluate" || req.url === "/api/qc")) {
    try {
      const payload=await readJsonBody(req);
      send(res,200,req.url==="/api/evaluate"?await evaluateCandidates(payload):await qcOutput(payload));
    } catch(error) {
      send(res,error.status||500,errorResponse(error,"Evaluation failed"));
    }
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/studio-flow-ui.html")) {
    return send(res, 200, fs.readFileSync(path.join(root, "studio-flow-ui.html")), "text/html; charset=utf-8");
  }
  send(res, 404, { error: "Not found" });
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) server.listen(port, "127.0.0.1", async () => {
  console.log(`Studio Flow: http://127.0.0.1:${port}`);
  console.log(`Backend: ${backend === "codex" ? "CODEX (gói ChatGPT — không tốn API credit)" : "API (OPENAI_API_KEY — tính phí)"}`);
  if (backend === "codex") {
    const bin = findCodex();
    console.log(bin ? `Codex CLI: ${bin}` : "Codex CLI: KHÔNG TÌM THẤY — đặt CODEX_CLI_PATH hoặc cài ChatGPT/Codex");
    console.log(`Model chấm : ${evalModel} (suy luận ${evalEffort})`);
    console.log(`Model vẽ   : ${renderModel} (suy luận ${renderEffort})`);
    if (bin) {
      const status = await codexAuthStatus();
      console.log(status.ok ? `Đăng nhập: ${status.detail || "OK"}` : `Đăng nhập: CHƯA — ${status.reason}`);
    }
    console.log("Đổi sang API cũ: đặt STUDIO_BACKEND=api trước khi chạy.");
  } else {
    console.log(apiKey ? "GPT Image 2: READY" : "GPT Image 2: CHƯA CÓ OPENAI_API_KEY");
  }
});

export { buildRenderPrompt, composeRenderPrompt, moderationFromLog, errorResponse, assertRenderPayload, normalizeEvaluation, recoverCodexGeneratedOutput };
