import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot, dbFile, ensureDirectories } from "./config.mjs";

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`; }
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function token() { return crypto.randomBytes(32).toString("base64url"); }
function equalHash(a, b) { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

function emptyState() {
  return { version: 1, users: [], helpers: [], sessions: [], projects: [], jobs: [], assets: [], audit: [] };
}

function parseConfiguredUsers() {
  const raw = process.env.STUDIO_TEAM_USERS_JSON;
  if (raw) {
    try {
      const users = JSON.parse(raw);
      if (Array.isArray(users) && users.length) return users;
    } catch (error) {
      console.warn(`STUDIO_TEAM_USERS_JSON không hợp lệ: ${error.message}`);
    }
  }
  return [{ id: "demo", name: "Demo", personalCode: process.env.STUDIO_BOOTSTRAP_CODE || "demo", helperToken: process.env.STUDIO_BOOTSTRAP_HELPER_TOKEN || "demo-helper" }];
}

export class JsonStore {
  constructor(file = dbFile) {
    this.file = file;
    ensureDirectories();
    this.state = this.load();
    this.ensureConfiguredUsers();
  }

  load() {
    try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) }; }
    catch { return emptyState(); }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(temp, this.file);
  }

  ensureConfiguredUsers() {
    for (const configured of parseConfiguredUsers()) {
      if (!configured?.id || !configured?.personalCode || !configured?.helperToken) continue;
      const existing = this.state.users.find(user => user.id === configured.id);
      if (existing) {
        existing.name = configured.name || existing.name || configured.id;
        existing.enabled = existing.enabled !== false;
        continue;
      }
      this.state.users.push({
        id: String(configured.id), name: String(configured.name || configured.id),
        personalCodeHash: hash(configured.personalCode), helperTokenHash: hash(configured.helperToken),
        enabled: true, createdAt: now()
      });
      this.state.helpers.push({ id: `helper_${configured.id}`, userId: String(configured.id), label: `${configured.name || configured.id} helper`, enabled: true, lastSeenAt: null, authenticated: false });
    }
    this.save();
  }

  userById(userId) { return this.state.users.find(user => user.id === userId) || null; }
  helperByUser(userId) { return this.state.helpers.find(helper => helper.userId === userId) || null; }

  userByPersonalCode(code) {
    const candidate = hash(code);
    return this.state.users.find(user => user.enabled !== false && equalHash(user.personalCodeHash, candidate)) || null;
  }

  helperByToken(rawToken) {
    const candidate = hash(rawToken);
    const user = this.state.users.find(item => item.enabled !== false && equalHash(item.helperTokenHash, candidate));
    if (!user) return null;
    const helper = this.helperByUser(user.id);
    if (!helper || helper.enabled === false) return null;
    return { user, helper };
  }

  createSession(userId) {
    const value = token();
    this.state.sessions = this.state.sessions.filter(session => session.expiresAt > Date.now());
    this.state.sessions.push({ tokenHash: hash(value), userId, expiresAt: Date.now() + Number(process.env.STUDIO_SESSION_TTL_MS || 8 * 60 * 60 * 1000), createdAt: now() });
    this.save();
    return value;
  }

  session(rawToken) {
    if (!rawToken) return null;
    const candidate = hash(rawToken);
    const session = this.state.sessions.find(item => item.expiresAt > Date.now() && equalHash(item.tokenHash, candidate));
    if (!session) return null;
    return this.userById(session.userId);
  }

  touchHelper(helperId, userId, authenticated) {
    let helper = this.state.helpers.find(item => item.id === helperId && item.userId === userId);
    if (!helper) {
      helper = { id: helperId, userId, label: helperId, enabled: true };
      this.state.helpers.push(helper);
    }
    helper.lastSeenAt = now();
    helper.authenticated = authenticated === true;
    this.save();
    return helper;
  }

  listHelpers(userId = null) {
    const cutoff = Date.now() - Number(process.env.STUDIO_HELPER_OFFLINE_MS || 45_000);
    return this.state.helpers.filter(item => !userId || item.userId === userId).map(item => ({
      ...item,
      online: Boolean(item.lastSeenAt && Date.parse(item.lastSeenAt) >= cutoff)
    }));
  }

  createProject(project) {
    const value = { id: id("project"), createdAt: now(), updatedAt: now(), ...project };
    this.state.projects.unshift(value);
    this.audit("project.created", value.ownerId, value.id);
    this.save();
    return value;
  }

  getProject(projectId) { return this.state.projects.find(project => project.id === projectId) || null; }
  listProjects(ownerId = null) { return this.state.projects.filter(project => !ownerId || project.ownerId === ownerId); }

  projectForUser(projectId, ownerId) {
    const project = this.getProject(projectId);
    return project && project.ownerId === ownerId ? project : null;
  }

  renameProject(projectId, ownerId, name) {
    const project = this.projectForUser(projectId, ownerId);
    if (!project) return null;
    project.name = name;
    project.updatedAt = now();
    for (const job of this.state.jobs.filter(item => item.ownerId === ownerId && item.projectId === projectId)) {
      job.project = { ...(job.project || {}), id: project.id, name: project.name, storageKey: project.storageKey };
      job.updatedAt = now();
    }
    this.audit("project.renamed", ownerId, project.id, { name });
    this.save();
    return project;
  }

  deleteProject(projectId, ownerId = null) {
    const index = this.state.projects.findIndex(project => project.id === projectId && (!ownerId || project.ownerId === ownerId));
    if (index < 0) return null;
    const [project] = this.state.projects.splice(index, 1);
    this.save();
    return project;
  }

  createJob(job) {
    const value = { id: id("job"), createdAt: now(), updatedAt: now(), ...job };
    this.state.jobs.unshift(value);
    this.audit("job.created", value.ownerId, value.id);
    this.save();
    return value;
  }

  getJob(jobId) { return this.state.jobs.find(job => job.id === jobId) || null; }
  listJobs(ownerId = null) { return this.state.jobs.filter(job => !ownerId || job.ownerId === ownerId); }

  deleteJob(jobId, ownerId = null) {
    const index = this.state.jobs.findIndex(job => job.id === jobId && (!ownerId || job.ownerId === ownerId));
    if (index < 0) return null;
    const [job] = this.state.jobs.splice(index, 1);
    this.save();
    return job;
  }

  resetUserData(ownerId) {
    const jobs = this.listJobs(ownerId);
    for (const job of jobs) this.deleteJobFiles(job.id);
    this.state.jobs = this.state.jobs.filter(job => job.ownerId !== ownerId);
    const projects = this.listProjects(ownerId);
    this.state.projects = this.state.projects.filter(project => project.ownerId !== ownerId);
    const assets = this.state.assets.filter(asset => asset.ownerId === ownerId);
    this.state.assets = this.state.assets.filter(asset => asset.ownerId !== ownerId);
    this.audit("account.data_reset", ownerId, ownerId, { projects: projects.length, jobs: jobs.length, assets: assets.length });
    this.save();
    return { projects: projects.length, jobs: jobs.length, assets: assets.length };
  }

  updateJob(jobId, patch) {
    const job = this.getJob(jobId);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: now() });
    this.save();
    return job;
  }

  deleteJobFiles(jobId) {
    const job = this.getJob(jobId);
    if (!job?.jobDir) return;
    try { fs.rmSync(job.jobDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  }

  addAsset(asset) {
    const value = { id: id("asset"), createdAt: now(), ...asset };
    this.state.assets.unshift(value);
    this.audit("asset.published", value.ownerId, value.id);
    this.save();
    return value;
  }

  listAssets() { return this.state.assets; }
  audit(action, userId, entityId, detail = null) { this.state.audit.push({ id: id("audit"), action, userId, entityId, detail, createdAt: now() }); }
  listUsers() { return this.state.users.map(({ personalCodeHash, helperTokenHash, ...safe }) => safe); }
  setUserEnabled(userId, enabled) { const user = this.userById(userId); if (!user) return null; user.enabled = Boolean(enabled); this.save(); return user; }
}

export { hash };
