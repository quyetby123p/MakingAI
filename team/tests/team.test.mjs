import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { JsonStore } from "../store.mjs";
import { WORKFLOW_LIMITS, retryInstructions, selectCandidate } from "../workflow-core.mjs";

test("workflow core preserves the current garment-transfer limits and retry guidance", () => {
  assert.deepEqual(WORKFLOW_LIMITS, { maxProducts: 5, maxProductViews: 8, maxModels: 10, maxVersions: 4 });
  const evaluation = { recommended_index: 1, candidates: [{ index: 0 }, { index: 1 }] };
  assert.equal(selectCandidate(evaluation).index, 1);
  assert.deepEqual(retryInstructions({ outputs: [{}, {}], lastQc: { strengths: ["blue trim"], rerender_reasons: ["length"] } }), { attempt: 3, rerenderReasons: ["length"], rerenderKeep: ["blue trim"] });
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
  const response = await fetch(`${origin}/api/jobs`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${claim.token}` }, body: JSON.stringify({ name: "Smoke", products: [{ name: "Demo", productImages: [png] }], modelImages: [png] }) });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.job.status, "WAITING_FOR_HELPER");
  assert.equal(data.job.products.length, 1);

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
  const finished = await fetch(`${origin}/internal/helpers/result`, { method: "POST", headers: { "content-type": "application/json", "x-helper-token": "integration-helper" }, body: JSON.stringify({ jobId: data.job.id, status: "DONE", products: [{ id: "product_1", evaluation: { compatibility: { decision: "AUTO_RENDER" } }, selectedModel: 0, output: { dataUrl: png, filename: "output.png" }, qc: { decision: "PASS", product_fidelity_score: 92 } }] }) }).then(r => r.json());
  assert.equal(finished.job.status, "DONE");
  assert.match(finished.job.products[0].outputs[0].outputUrl, /products\/product_1\/output$/);
  const outputResponse = await fetch(`${origin}${finished.job.products[0].outputs[0].outputUrl}`, { headers: { authorization: `Bearer ${claim.token}` } });
  assert.equal(outputResponse.status, 200);
  assert.match(outputResponse.headers.get("content-type") || "", /image\/png/);
  assert.match(finished.job.products[0].outputs[0].previewUrl, /output\?preview=1$/);
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
  const reset = await fetch(`${origin}/api/account/reset`, { method: "POST", headers: { authorization: `Bearer ${claim.token}` } }).then(r => r.json());
  assert.equal(reset.removed.jobs, 1);
  const afterReset = await fetch(`${origin}/api/jobs`, { headers: { authorization: `Bearer ${claim.token}` } }).then(r => r.json());
  assert.equal(afterReset.jobs.length, 0);
});
