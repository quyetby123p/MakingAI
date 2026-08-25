import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { JsonStore } from "../store.mjs";
import { WORKFLOW_LIMITS, retryInstructions, selectCandidate } from "../workflow-core.mjs";
import { recoverCodexGeneratedOutput } from "../../server.mjs";

test("workflow core preserves the current garment-transfer limits and retry guidance", () => {
  assert.deepEqual(WORKFLOW_LIMITS, { maxProducts: 5, maxProductViews: 8, maxModels: 10, maxVersions: 4 });
  const evaluation = { recommended_index: 1, candidates: [{ index: 0 }, { index: 1 }] };
  assert.equal(selectCandidate(evaluation).index, 1);
  assert.deepEqual(retryInstructions({ outputs: [{}, {}], lastQc: { strengths: ["blue trim"], rerender_reasons: ["length"] } }), { attempt: 3, rerenderReasons: ["length"], rerenderKeep: ["blue trim"] });
  const fallbackRetry = retryInstructions({ outputs: [{}, {}], lastQc: null });
  assert.equal(fallbackRetry.attempt, 3);
  assert.ok(fallbackRetry.rerenderReasons.length >= 2);
});

test("local engine recovers Codex image_gen managed output path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-flow-recover-"));
  const previousSessionRoot = process.env.CODEX_SESSION_ROOT;
  const png = Buffer.concat([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    Buffer.alloc(2048)
  ]);
  try {
    const sessionRoot = path.join(dir, "sessions");
    const generatedDir = path.join(dir, "generated_images", "thread");
    const jobDir = path.join(dir, "render-job");
    fs.mkdirSync(path.join(sessionRoot, String(new Date().getFullYear()), String(new Date().getMonth() + 1).padStart(2, "0"), String(new Date().getDate()).padStart(2, "0")), { recursive: true });
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.mkdirSync(jobDir, { recursive: true });
    const managedOutput = path.join(generatedDir, "exec-output.png");
    const expectedOutput = path.join(jobDir, "output.png");
    fs.writeFileSync(managedOutput, png);
    const sessionFile = path.join(sessionRoot, String(new Date().getFullYear()), String(new Date().getMonth() + 1).padStart(2, "0"), String(new Date().getDate()).padStart(2, "0"), "rollout-test.jsonl");
    const line = {
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        revised_prompt: `Save/export the final image directly to ${expectedOutput}.`,
        saved_path: managedOutput
      }
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(line)}\n`, "utf8");
    process.env.CODEX_SESSION_ROOT = sessionRoot;

    const recovered = await recoverCodexGeneratedOutput(jobDir, expectedOutput, Date.now() - 1000);
    assert.equal(recovered.recovered, true);
    assert.equal(fs.existsSync(expectedOutput), true);
    assert.equal(fs.readFileSync(expectedOutput).equals(png), true);
  } finally {
    if (previousSessionRoot === undefined) delete process.env.CODEX_SESSION_ROOT;
    else process.env.CODEX_SESSION_ROOT = previousSessionRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("JsonStore hashes personal/helper credentials and returns only enabled users", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-flow-store-"));
  const file = path.join(dir, "store.json");
  const previous = { code: process.env.STUDIO_BOOTSTRAP_CODE, helper: process.env.STUDIO_BOOTSTRAP_HELPER_TOKEN };
  process.env.STUDIO_BOOTSTRAP_CODE = "unit-code";
  process.env.STUDIO_BOOTSTRAP_HELPER_TOKEN = "unit-helper";
  const store = new JsonStore(file);
  assert.equal(store.userByPersonalCode("unit-code")?.id, "demo");
  assert.equal(store.userByPersonalCode("wrong"), null);
  assert.equal(store.helperByToken("unit-helper")?.user.id, "demo");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.users[0].personalCodeHash.includes("unit-code"), false);
  process.env.STUDIO_BOOTSTRAP_CODE = previous.code;
  process.env.STUDIO_BOOTSTRAP_HELPER_TOKEN = previous.helper;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("central server claims a session and validates a job payload", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-flow-central-"));
  const port = 4300 + Math.floor(Math.random() * 500);
  const central = path.resolve("team/central-server.mjs");
  const child = spawn(process.execPath, [central], {
    cwd: process.cwd(),
    env: { ...process.env, STUDIO_TEAM_PORT: String(port), STUDIO_TEAM_DATA_DIR: dir, STUDIO_BOOTSTRAP_CODE: "integration-code", STUDIO_BOOTSTRAP_HELPER_TOKEN: "integration-helper", STUDIO_ADMIN_KEY: "admin" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("central server start timeout")), 8000);
    child.stdout.on("data", data => { if (String(data).includes("Studio Flow Team:")) { clearTimeout(timer); resolve(); } });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`central exited ${code}`)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const claim = await fetch(`${origin}/api/session/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "integration-code" }) }).then(r => r.json());
  assert.ok(claim.token);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const project = await fetch(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${claim.token}` }, body: JSON.stringify({ name: "Project cũ" }) }).then(r => r.json());
  assert.equal(project.project.name, "Project cũ");
  const renamed = await fetch(`${origin}/api/projects/${project.project.id}`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${claim.token}` }, body: JSON.stringify({ name: "Project mới" }) }).then(r => r.json());
  assert.equal(renamed.project.name, "Project mới");
  const response = await fetch(`${origin}/api/jobs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${claim.token}` }, body: JSON.stringify({ projectId: project.project.id, name: "Smoke", products: [{ name: "Demo", productImages: [png] }], modelImages: [png] }) });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.job.status, "WAITING_FOR_HELPER");
  assert.equal(data.job.products.length, 1);
  assert.equal(data.job.inputHistory.modelImages.length, 1);
  assert.equal(data.job.products[0].productReferences.length, 1);

  const helperJob = await fetch(`${origin}/internal/helpers/poll`, { method: "POST", headers: { "content-type": "application/json", "x-helper-token": "integration-helper" }, body: JSON.stringify({ helperId: "test-helper", authenticated: true }) }).then(r => r.json());
  assert.equal(helperJob.job.id, data.job.id);
  const progress = await fetch(`${origin}/internal/helpers/progress`, { method: "POST", headers: { "content-type": "application/json", "x-helper-token": "integration-helper" }, body: JSON.stringify({ jobId: data.job.id, productId: "product_1", status: "EVALUATED", jobStatus: "EVALUATED", selectedModel: 0, evaluation: { input_quality: { input_readiness_score: 88 }, compatibility: { final_score: 91, decision: "AUTO_RENDER" } }, message: "Đã đánh giá xong" }) }).then(r => r.json());
  assert.equal(progress.job.status, "EVALUATED");
  assert.equal(progress.job.products[0].evaluation.compatibility.final_score, 91);
  const evaluated = await fetch(`${origin}/internal/helpers/result`, { method: "POST", headers: { "content-type": "application/json", "x-helper-token": "integration-helper" }, body: JSON.stringify({ jobId: data.job.id, status: "AWAITING_EVALUATION_APPROVAL", products: [{ id: "product_1", evaluation: progress.job.products[0].evaluation, selectedModel: 0 }] }) }).then(r => r.json());
  assert.equal(evaluated.job.status, "AWAITING_EVALUATION_APPROVAL");
  const approval = await fetch(`${origin}/api/jobs/${data.job.id}/approve-render`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${claim.token}` }, body: JSON.stringify({ productIds: ["product_1"] }) }).then(r => r.json());
  assert.equal(approval.job.status, "WAITING_FOR_HELPER");
  const renderPoll = await fetch(`${origin}/internal/helpers/poll`, { method: "POST", headers: { "content-type": "application/json", "x-helper-token": "integration-helper" }, body: JSON.stringify({ helperId: "test-helper", authenticated: true }) }).then(r => r.json());
  assert.equal(renderPoll.job.id, data.job.id);
  assert.deepEqual(renderPoll.job.renderRequests, ["product_1"]);
  const finished = await fetch(`${origin}/internal/helpers/result`, { method: "POST", headers: { "content-type": "application/json", "x-helper-token": "integration-helper" }, body: JSON.stringify({ jobId: data.job.id, status: "DONE", products: [{ id: "product_1", evaluation: { compatibility: { decision: "AUTO_RENDER" } }, selectedModel: 0, output: { dataUrl: png, filename: "output.png" }, qc: null }] }) }).then(r => r.json());
  assert.equal(finished.job.status, "DONE");
  assert.equal(finished.job.products[0].outputs[0].qc, null);
  assert.match(finished.job.products[0].outputs[0].outputUrl, /products\/product_1\/output\?version=1&cache=/);
  assert.match(finished.job.products[0].outputs[0].previewUrl, /products\/product_1\/output\?preview=1&version=1&cache=/);
  const outputResponse = await fetch(`${origin}${finished.job.products[0].outputs[0].outputUrl}`, { headers: { authorization: `Bearer ${claim.token}` } });
  assert.equal(outputResponse.status, 200);
  assert.match(outputResponse.headers.get("content-type") || "", /image\/png/);
  assert.match(finished.job.products[0].outputs[0].previewUrl, /output\?preview=1&version=1&cache=/);
  const outputPreview = await fetch(`${origin}${finished.job.products[0].outputs[0].previewUrl}`, { headers: { authorization: `Bearer ${claim.token}` } });
  assert.equal(outputPreview.status, 200);
  assert.match(outputPreview.headers.get("content-type") || "", /image\/jpeg/);
  assert.equal(finished.job.products[0].selectedModel, 0);
  assert.match(finished.job.products[0].modelReferenceUrl, /references\/model\/0$/);
  const modelResponse = await fetch(`${origin}${finished.job.products[0].modelReferenceUrl}`, { headers: { authorization: `Bearer ${claim.token}` } });
  assert.equal(modelResponse.status, 200);
  assert.match(modelResponse.headers.get("content-type") || "", /image\/png/);
  assert.match(finished.job.products[0].modelReferencePreviewUrl, /references\/model\/0\?preview=1$/);
  const modelPreview = await fetch(`${origin}${finished.job.products[0].modelReferencePreviewUrl}`, { headers: { authorization: `Bearer ${claim.token}` } });
  assert.equal(modelPreview.status, 200);
  assert.match(modelPreview.headers.get("content-type") || "", /image\/jpeg/);
  assert.match(finished.job.products[0].productReferenceUrl, /references\/product\/product_1$/);
  const productReference = await fetch(`${origin}${finished.job.products[0].productReferenceUrl}`, { headers: { authorization: `Bearer ${claim.token}` } });
  assert.equal(productReference.status, 200);
  assert.match(productReference.headers.get("content-type") || "", /image\/png/);
  assert.match(finished.job.products[0].productReferencePreviewUrl, /references\/product\/product_1\?preview=1$/);
  const productPreview = await fetch(`${origin}${finished.job.products[0].productReferencePreviewUrl}`, { headers: { authorization: `Bearer ${claim.token}` } });
  assert.equal(productPreview.status, 200);
  assert.match(productPreview.headers.get("content-type") || "", /image\/jpeg/);
  const productHistoryPreview = await fetch(`${origin}${finished.job.products[0].productReferences[0].previewUrl}`, { headers: { authorization: `Bearer ${claim.token}` } });
  assert.equal(productHistoryPreview.status, 200);
  const modelHistoryPreview = await fetch(`${origin}${finished.job.inputHistory.modelImages[0].previewUrl}`, { headers: { authorization: `Bearer ${claim.token}` } });
  assert.equal(modelHistoryPreview.status, 200);
  const reset = await fetch(`${origin}/api/account/reset`, { method: "POST", headers: { authorization: `Bearer ${claim.token}` } }).then(r => r.json());
  assert.equal(reset.removed.jobs, 1);
  const afterReset = await fetch(`${origin}/api/jobs`, { headers: { authorization: `Bearer ${claim.token}` } }).then(r => r.json());
  assert.equal(afterReset.jobs.length, 0);
});

test("shared host helper can process employee jobs while data stays under employee session", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-flow-shared-helper-"));
  const port = 4800 + Math.floor(Math.random() * 500);
  const central = path.resolve("team/central-server.mjs");
  const users = [
    { id: "owner", name: "Owner", personalCode: "owner-code", helperToken: "owner-helper" },
    { id: "media001", name: "Media 001", personalCode: "media001", helperToken: "media-helper" }
  ];
  const child = spawn(process.execPath, [central], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STUDIO_TEAM_PORT: String(port),
      STUDIO_TEAM_DATA_DIR: dir,
      STUDIO_TEAM_USERS_JSON: JSON.stringify(users),
      STUDIO_SHARED_HOST_HELPER_USER_IDS: "owner",
      STUDIO_ADMIN_KEY: "admin"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("central server start timeout")), 8000);
    child.stdout.on("data", data => { if (String(data).includes("Studio Flow Team:")) { clearTimeout(timer); resolve(); } });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`central exited ${code}`)); });
  });

  const origin = `http://127.0.0.1:${port}`;
  const mediaClaim = await fetch(`${origin}/api/session/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "media001" }) }).then(r => r.json());
  assert.ok(mediaClaim.token);

  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const created = await fetch(`${origin}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${mediaClaim.token}` },
    body: JSON.stringify({ name: "Media batch", products: [{ name: "Demo", productImages: [png] }], modelImages: [png] })
  }).then(r => r.json());
  assert.equal(created.job.status, "WAITING_FOR_HELPER");
  const createdSecond = await fetch(`${origin}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${mediaClaim.token}` },
    body: JSON.stringify({ name: "Media batch 2", products: [{ name: "Demo 2", productImages: [png] }], modelImages: [png] })
  }).then(r => r.json());
  assert.equal(createdSecond.job.status, "WAITING_FOR_HELPER");

  const hostPoll = await fetch(`${origin}/internal/helpers/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-helper-token": "owner-helper" },
    body: JSON.stringify({ helperId: "owner-main", authenticated: true })
  }).then(r => r.json());
  assert.equal(hostPoll.job.id, created.job.id);
  const hostSecondPoll = await fetch(`${origin}/internal/helpers/poll`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-helper-token": "owner-helper" },
    body: JSON.stringify({ helperId: "owner-main", authenticated: true })
  }).then(r => r.json());
  assert.equal(hostSecondPoll.job.id, createdSecond.job.id);

  const progress = await fetch(`${origin}/internal/helpers/progress`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-helper-token": "owner-helper" },
    body: JSON.stringify({
      helperId: "owner-main",
      jobId: created.job.id,
      productId: "product_1",
      status: "EVALUATED",
      jobStatus: "EVALUATED",
      selectedModel: 0,
      evaluation: { compatibility: { final_score: 90, decision: "AUTO_RENDER" } },
      message: "Host helper đã đánh giá"
    })
  }).then(r => r.json());
  assert.equal(progress.job.products[0].evaluation.compatibility.final_score, 90);

  const mediaJobs = await fetch(`${origin}/api/jobs`, { headers: { authorization: `Bearer ${mediaClaim.token}` } }).then(r => r.json());
  assert.equal(mediaJobs.jobs.length, 2);
  const originalJob = mediaJobs.jobs.find(job => job.id === created.job.id);
  assert.equal(originalJob.products[0].evaluation.compatibility.final_score, 90);
});

test("central server recovers model capacity errors as retryable render approvals", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-flow-capacity-"));
  const port = 5300 + Math.floor(Math.random() * 500);
  const central = path.resolve("team/central-server.mjs");
  const child = spawn(process.execPath, [central], {
    cwd: process.cwd(),
    env: { ...process.env, STUDIO_TEAM_PORT: String(port), STUDIO_TEAM_DATA_DIR: dir, STUDIO_BOOTSTRAP_CODE: "capacity-code", STUDIO_BOOTSTRAP_HELPER_TOKEN: "capacity-helper" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("central server start timeout")), 8000);
    child.stdout.on("data", data => { if (String(data).includes("Studio Flow Team:")) { clearTimeout(timer); resolve(); } });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`central exited ${code}`)); });
  });

  const origin = `http://127.0.0.1:${port}`;
  const claim = await fetch(`${origin}/api/session/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "capacity-code" }) }).then(r => r.json());
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const created = await fetch(`${origin}/api/jobs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${claim.token}` }, body: JSON.stringify({ name: "Capacity", products: [{ name: "Demo", productImages: [png] }], modelImages: [png] }) }).then(r => r.json());
  const claimed = await fetch(`${origin}/internal/helpers/poll`, { method: "POST", headers: { "content-type": "application/json", "x-helper-token": "capacity-helper" }, body: JSON.stringify({ helperId: "capacity-helper-id", authenticated: true }) }).then(r => r.json());
  assert.equal(claimed.job.id, created.job.id);
  const evaluation = { compatibility: { final_score: 91, decision: "AUTO_RENDER" }, input_quality: { input_readiness_score: 91 } };
  const failed = await fetch(`${origin}/internal/helpers/result`, { method: "POST", headers: { "content-type": "application/json", "x-helper-token": "capacity-helper" }, body: JSON.stringify({ jobId: created.job.id, status: "FAILED", products: [{ id: "product_1", evaluation, selectedModel: 0, error: "ERROR: Selected model is at capacity. Please try a different model." }] }) }).then(r => r.json());
  assert.equal(failed.job.status, "AWAITING_EVALUATION_APPROVAL");
  assert.equal(failed.job.errors.length, 0);
  assert.equal(failed.job.products[0].status, "EVALUATED");
  assert.match(failed.job.products[0].progressMessage, /quá tải/);
});
