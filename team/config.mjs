import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");
export const dataRoot = path.resolve(process.env.STUDIO_TEAM_DATA_DIR || path.join(repoRoot, "team-data"));
export const dbFile = path.join(dataRoot, "store.json");
export const jobsRoot = path.join(dataRoot, "jobs");
export const centralPort = Number(process.env.STUDIO_TEAM_PORT || process.env.PORT || 4180);
export const centralOrigin = (process.env.STUDIO_CENTRAL_URL || `http://127.0.0.1:${centralPort}`).replace(/\/$/, "");
export const helperId = process.env.STUDIO_HELPER_ID || `${process.platform}-${process.hostname || "machine"}`;
export const maxBodyBytes = Number(process.env.STUDIO_TEAM_MAX_BODY || 80 * 1024 * 1024);
export const maxProducts = 5;
export const maxProductViews = 8;
export const maxModels = 10;
export const maxVersions = 4;
export const sessionTtlMs = Number(process.env.STUDIO_SESSION_TTL_MS || 8 * 60 * 60 * 1000);
export const helperOfflineMs = Number(process.env.STUDIO_HELPER_OFFLINE_MS || 45_000);
export const sharedHostHelperUserIds = new Set(
  String(process.env.STUDIO_SHARED_HOST_HELPER_USER_IDS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

export function ensureDirectories() {
  return { dataRoot, jobsRoot };
}

export function safeName(value, fallback = "asset") {
  const text = String(value || fallback).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return text.slice(0, 100) || fallback;
}

export function mimeExtension(mime) {
  const ext = String(mime || "image/png").split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  return ext === "jpeg" ? "jpg" : ext;
}
