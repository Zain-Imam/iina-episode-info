#!/usr/bin/env node
// Episode Info — API health check.
//
// Verifies that every service the plugin depends on still behaves the way
// main.js and sidebar.html expect. Exits 0 when everything is intact, 1 when
// something has broken.
//
//   node scripts/check-apis.mjs
//
// Keys (TMDB_API_KEY, OPENSUBTITLES_API_KEY, SUBDL_API_KEY, WYZIE_API_KEY) are
// read from the environment or a local .env, and are optional: without them the
// endpoints are still checked for being alive and enforcing auth, which is what
// catches a moved or retired API. Never calls OpenSubtitles' /download, so it
// cannot consume the free daily quota.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env reader so local runs need no dependencies. Real environment
// variables always win, so CI secrets are never shadowed by a stray file.
function loadDotEnv() {
  let raw;
  try { raw = readFileSync(join(ROOT, ".env"), "utf8"); } catch { return false; }
  let loaded = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded++;
  }
  return loaded;
}

const INFO = JSON.parse(readFileSync(join(ROOT, "Info.json"), "utf8"));

// Matches the plugin's own User-Agent; OpenSubtitles rejects requests without one.
const UA = `EpisodeInfo v${INFO.version}`;
const TIMEOUT_MS = 20000;
const RETRIES = 3;
// Upstream hiccups that say nothing about the plugin being broken.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// Stable, heavily-subtitled fixtures.
const TV = { tmdb: 1399, imdb: "tt0944947", name: "Game of Thrones" };
const MOVIE = { tmdb: 550, imdb: "tt0137523", name: "Fight Club" };

// Same normalisation as stripTtAndZeros() in main.js. OpenSubtitles returns an
// HTML error page for ids that keep their leading zeros, so this matters.
const bareImdb = (id) => String(id).replace(/^tt/i, "").replace(/^0+/, "");

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  const icon = { pass: "PASS", fail: "FAIL", skip: "SKIP", warn: "WARN" }[status];
  console.log(`${icon.padEnd(4)}  ${name.padEnd(46)}  ${detail}`);
};

// --- fetch with timeout + retries, so a blip does not raise a false alarm ----
async function get(url, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctl.signal,
        headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) },
      });
      clearTimeout(timer);
      if (RETRYABLE.has(res.status) && attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json — fine */ }
      return { status: res.status, json, text, headers: res.headers };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

// A check must fail twice to count. Third-party APIs occasionally return a
// malformed 200, and a badge that cries wolf stops being read.
async function check(name, fn) {
  try {
    let out;
    try {
      out = await fn();
    } catch (first) {
      await new Promise((r) => setTimeout(r, 3000));
      out = await fn();
    }
    if (out && out.skip) record(name, "skip", out.skip);
    else if (out && out.warn) record(name, "warn", out.warn);
    else record(name, "pass", (out && out.detail) || "ok");
  } catch (err) {
    record(name, "fail", err.message);
  }
}

const need = (cond, msg) => { if (!cond) throw new Error(msg); };

// 1. Static check — every URL in the code is allow-listed in Info.json.
async function checkAllowlist() {
  const info = JSON.parse(readFileSync(join(ROOT, "Info.json"), "utf8"));
  const allowed = new Set(info.allowedDomains || []);
  const sources = ["main.js", "sidebar.html", "overlay.html"];
  const hosts = new Set();

  for (const file of sources) {
    let src;
    try { src = readFileSync(join(ROOT, file), "utf8"); } catch { continue; }
    // Only hosts the plugin itself calls through iina.http / fetch.
    for (const m of src.matchAll(/(?:iina\.http\.\w+|fetch)\(\s*["'`](https:\/\/[^"'`\/]+)/g)) {
      hosts.add(new URL(m[1]).hostname);
    }
    // String-concatenated URLs, e.g. "https://api.themoviedb.org/3/tv/" + id
    for (const m of src.matchAll(/["'`]https:\/\/(api\.[^"'`\/]+|image\.[^"'`\/]+|dl\.[^"'`\/]+|sub\.[^"'`\/]+)/g)) {
      hosts.add(m[1]);
    }
  }

  const missing = [...hosts].filter((h) => !allowed.has(h));
  need(missing.length === 0, `host(s) called in code but NOT in Info.json allowedDomains: ${missing.join(", ")}`);
  return { detail: `${hosts.size} hosts called, all allow-listed` };
}

// 2. TMDB — the only hard requirement. Every route the plugin uses.
async function checkTmdbRoutes() {
  const key = process.env.TMDB_API_KEY;
  const routes = [
    ["/3/search/multi", { query: TV.name }],
    ["/3/configuration", {}],
    [`/3/tv/${TV.tmdb}`, {}],
    [`/3/tv/${TV.tmdb}/external_ids`, {}],
    [`/3/tv/${TV.tmdb}/season/1`, {}],
    [`/3/movie/${MOVIE.tmdb}`, {}],
    [`/3/movie/${MOVIE.tmdb}/external_ids`, {}],
  ];

  const bad = [];
  for (const [path, params] of routes) {
    const qs = new URLSearchParams({ ...params, api_key: key || "INVALID_KEY_HEALTHCHECK" });
    const r = await get(`https://api.themoviedb.org${path}?${qs}`);
    // With a key: 200. Without: 401 + TMDB's status_code 7 proves the route lives.
    const ok = key ? r.status === 200 : r.status === 401 && r.json?.status_code === 7;
    if (!ok) bad.push(`${path} -> HTTP ${r.status}${r.json?.status_message ? ` (${r.json.status_message})` : ""}`);
  }
  need(bad.length === 0, bad.join("; "));
  return { detail: key ? `${routes.length} routes returned 200` : `${routes.length} routes alive (no key: verified 401/status_code 7)` };
}

async function checkTmdbShape() {
  const key = process.env.TMDB_API_KEY;
  if (!key) return { skip: "no TMDB_API_KEY secret — response shape not verified" };

  const search = await get(`https://api.themoviedb.org/3/search/multi?api_key=${key}&query=${encodeURIComponent(TV.name)}`);
  need(search.status === 200, `search/multi HTTP ${search.status}`);
  need(Array.isArray(search.json?.results) && search.json.results.length > 0, "search/multi returned no results array");
  const hit = search.json.results.find((r) => r.media_type === "tv" || r.media_type === "movie");
  need(hit, "no result carried media_type (sidebar.html branches on it)");
  need("id" in hit && ("name" in hit || "title" in hit), "result missing id/name/title used by the sidebar");

  // main.js resolves IMDB ids from here; the whole subtitle cascade depends on it.
  const ext = await get(`https://api.themoviedb.org/3/tv/${TV.tmdb}/external_ids?api_key=${key}`);
  need(ext.status === 200, `external_ids HTTP ${ext.status}`);
  need(ext.json?.imdb_id === TV.imdb, `external_ids.imdb_id was "${ext.json?.imdb_id}", expected ${TV.imdb}`);

  // Season episodes feed the episode picker.
  const season = await get(`https://api.themoviedb.org/3/tv/${TV.tmdb}/season/1?api_key=${key}`);
  need(season.status === 200, `season HTTP ${season.status}`);
  need(Array.isArray(season.json?.episodes) && season.json.episodes.length > 0, "season.episodes missing");
  const ep = season.json.episodes[0];
  need("episode_number" in ep && "name" in ep, "episode missing episode_number/name");

  return { detail: `search + external_ids (${TV.imdb}) + ${season.json.episodes.length} episodes all match` };
}

async function checkTmdbImages() {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    // Still confirm the image CDN is serving at all.
    const r = await get("https://image.tmdb.org/t/p/w92/");
    need(r.status < 500, `image.tmdb.org returned HTTP ${r.status}`);
    return { skip: "no TMDB_API_KEY — CDN reachable, poster not fetched" };
  }
  const cfg = await get(`https://api.themoviedb.org/3/configuration?api_key=${key}`);
  need(cfg.status === 200, `configuration HTTP ${cfg.status}`);
  const base = cfg.json?.images?.secure_base_url;
  need(base, "configuration.images.secure_base_url missing (sidebar builds poster URLs from it)");

  const tv = await get(`https://api.themoviedb.org/3/tv/${TV.tmdb}?api_key=${key}`);
  const path = tv.json?.poster_path;
  need(path, "poster_path missing");
  const img = await get(`${base}w92${path}`);
  need(img.status === 200, `poster fetch HTTP ${img.status}`);
  const ct = img.headers.get("content-type") || "";
  need(ct.startsWith("image/"), `poster content-type was "${ct}"`);
  return { detail: `${base}w92 serving images` };
}

// 3. OpenSubtitles — search only, never /download (protects the free quota).
async function checkOpenSubtitles() {
  const key = process.env.OPENSUBTITLES_API_KEY;
  // The plugin's primary TV path — proves season/episode params are still honoured.
  const url = `https://api.opensubtitles.com/api/v1/subtitles?parent_imdb_id=${bareImdb(TV.imdb)}`
    + "&season_number=1&episode_number=1&languages=en";

  if (!key) {
    const r = await get(url);
    // 401/403 both prove the route exists and is enforcing auth as documented.
    need([401, 403].includes(r.status), `expected 401/403 without a key, got HTTP ${r.status}`);
    need(r.json !== null, "error response was not JSON — service may have changed");
    return { skip: `no OPENSUBTITLES_API_KEY — endpoint alive (HTTP ${r.status}, JSON error)` };
  }

  const r = await get(url, { headers: { "Api-Key": key } });
  need(r.status === 200, `HTTP ${r.status}${r.json?.message ? ` (${r.json.message})` : ""}`);
  need(Array.isArray(r.json?.data), "response.data array missing (main.js reads body.data)");
  if (r.json.data.length > 0) {
    const a = r.json.data[0].attributes;
    need(a, "result missing .attributes");
    need(Array.isArray(a.files), "result missing attributes.files (file_id feeds the download call)");
  }
  return { detail: `${r.json.data.length} subtitles returned, shape intact` };
}

// 4. SubDL
async function checkSubdl() {
  const key = process.env.SUBDL_API_KEY;
  const base = "https://api.subdl.com/api/v1/subtitles";

  if (!key) {
    const r = await get(`${base}?api_key=INVALID_KEY_HEALTHCHECK&film_name=${encodeURIComponent(MOVIE.name)}`);
    need([401, 403].includes(r.status), `expected 401/403 without a key, got HTTP ${r.status}`);
    need(r.json?.status === false, "error body missing status:false — response contract changed");
    return { skip: `no SUBDL_API_KEY — endpoint alive (HTTP ${r.status}, ${r.json?.error || "auth enforced"})` };
  }

  const qs = new URLSearchParams({
    api_key: key, tmdb_id: String(TV.tmdb), type: "tv",
    season_number: "1", episode_number: "1", languages: "EN", subs_per_page: "5",
  });
  const r = await get(`${base}?${qs}`);
  need(r.status === 200, `HTTP ${r.status}${r.json?.error ? ` (${r.json.error})` : ""}`);
  need(r.json?.status === true, `status was ${JSON.stringify(r.json?.status)} (main.js requires status === true)`);
  need(Array.isArray(r.json?.subtitles), "subtitles array missing");
  if (r.json.subtitles.length > 0) {
    need("url" in r.json.subtitles[0], "subtitle entry has no url (used to download the zip)");
  }
  return { detail: `${r.json.subtitles.length} subtitles returned, status:true` };
}

// SubDL hands back zip archives from a separate host — make sure it is up.
async function checkSubdlCdn() {
  const r = await get("https://dl.subdl.com/");
  need(r.status < 500, `dl.subdl.com returned HTTP ${r.status}`);
  return { detail: `dl.subdl.com reachable (HTTP ${r.status})` };
}

// 5. Wyzie
async function checkWyzie() {
  const key = process.env.WYZIE_API_KEY;
  const params = new URLSearchParams({
    id: TV.imdb, season: "1", episode: "1", format: "srt", language: "en",
  });
  if (key) params.set("key", key);
  const r = await get(`https://sub.wyzie.io/search?${params}`);

  if (!key) {
    need(r.status === 401, `expected 401 without a key, got HTTP ${r.status}`);
    need(/api key/i.test(r.json?.message || ""), `unexpected error body: ${r.text.slice(0, 120)}`);
    return { skip: `no WYZIE_API_KEY — endpoint alive (HTTP 401, "${r.json.message}")` };
  }

  need(r.status === 200, `HTTP ${r.status}${r.json?.message ? ` (${r.json.message})` : ""}`);
  const arr = Array.isArray(r.json) ? r.json : r.json?.results;
  need(Array.isArray(arr), "expected a JSON array of subtitles (main.js reads the array directly)");
  if (arr.length > 0) need("url" in arr[0], "subtitle entry has no url");
  return { detail: `${arr.length} subtitles returned` };
}

// The plugin used to call sub.wyzie.ru. Warn if the .io host it now calls
// ever starts redirecting somewhere else again.
async function checkWyzieHost() {
  const res = await fetch("https://sub.wyzie.io/search?id=tt0944947", {
    redirect: "manual", headers: { "User-Agent": UA },
  });
  if (res.status >= 300 && res.status < 400) {
    return { warn: `sub.wyzie.io now redirects to ${res.headers.get("location")} — update main.js` };
  }
  return { detail: `sub.wyzie.io answers directly (HTTP ${res.status}, no redirect)` };
}

// 6. Every host in Info.json resolves and answers. Catches a domain move
async function checkAllowlistedHostsLive() {
  const info = JSON.parse(readFileSync(join(ROOT, "Info.json"), "utf8"));
  const dead = [];
  for (const host of info.allowedDomains || []) {
    try {
      const r = await get(`https://${host}/`);
      if (r.status >= 500) dead.push(`${host} -> HTTP ${r.status}`);
    } catch (err) {
      dead.push(`${host} -> ${err.message}`);
    }
  }
  need(dead.length === 0, `unreachable: ${dead.join(", ")}`);
  return { detail: `${(info.allowedDomains || []).length} allow-listed hosts reachable` };
}


// 6. Skip-intro sources. All keyless; the plugin treats each as optional, so
//    this fails only if the contract changed, not if one has no data.
async function checkSkipSources() {
  const qs = `imdb_id=${TV.imdb}&season=1&episode=1`;
  const bad = [];

  const introdb = await get(`https://api.introdb.app/segments?${qs}`);
  if (introdb.status !== 200) bad.push(`IntroDB HTTP ${introdb.status}`);
  else if (!("intro" in (introdb.json || {}))) bad.push("IntroDB response lost its `intro` key");

  const theintrodb = await get(`https://api.theintrodb.org/v2/media?${qs}`);
  if (theintrodb.status !== 200) bad.push(`TheIntroDB HTTP ${theintrodb.status}`);
  else if (theintrodb.json && "intro" in theintrodb.json && !Array.isArray(theintrodb.json.intro)) {
    bad.push("TheIntroDB `intro` is no longer an array");
  }

  const skipdb = await get(`https://api.skipdb.tv/api/segments?${qs}`);
  if (skipdb.status !== 200) bad.push(`SkipDB HTTP ${skipdb.status}`);
  else if (!skipdb.json || typeof skipdb.json.segments !== "object") {
    bad.push("SkipDB response lost its `segments` object");
  }

  need(bad.length === 0, bad.join("; "));

  const withData = [
    introdb.json?.intro ? "IntroDB" : null,
    theintrodb.json?.intro?.length ? "TheIntroDB" : null,
    skipdb.json?.segments?.intro ? "SkipDB" : null,
  ].filter(Boolean);
  return { detail: `3 sources answering, ${withData.length} with intro data (${withData.join(", ") || "none"})` };
}

// Run everything, then write the summary.
const fromDotEnv = loadDotEnv();

const KEY_NAMES = ["TMDB_API_KEY", "OPENSUBTITLES_API_KEY", "SUBDL_API_KEY", "WYZIE_API_KEY"];
const configured = KEY_NAMES.filter((k) => process.env[k]);

console.log("Episode Info — API health check");
if (fromDotEnv !== false) {
  console.log(`Loaded .env (${fromDotEnv} key${fromDotEnv === 1 ? "" : "s"} set)`);
}
console.log(
  configured.length
    ? `Keys in use: ${configured.join(", ")}`
    : "No keys set — running liveness checks only. Add them to .env for full verification."
);
console.log("");

await check("Info.json allow-list covers every called host", checkAllowlist);
await check("TMDB — all routes used by the plugin", checkTmdbRoutes);
await check("TMDB — response shape (search, ids, episodes)", checkTmdbShape);
await check("TMDB — image CDN and poster paths", checkTmdbImages);
await check("OpenSubtitles — search endpoint", checkOpenSubtitles);
await check("SubDL — search endpoint", checkSubdl);
await check("SubDL — download host", checkSubdlCdn);
await check("Wyzie — search endpoint", checkWyzie);
await check("Wyzie — host still answers directly", checkWyzieHost);
await check("Skip-intro sources (IntroDB/TheIntroDB/SkipDB)", checkSkipSources);
await check("All allow-listed hosts reachable", checkAllowlistedHostsLive);

const failed = results.filter((r) => r.status === "fail");
const warned = results.filter((r) => r.status === "warn");
const skipped = results.filter((r) => r.status === "skip");

const icons = { pass: "✅", fail: "❌", skip: "⏭️", warn: "⚠️" };
const summary = [
  `## ${failed.length ? "❌ API health: FAILING" : warned.length ? "⚠️ API health: passing with warnings" : "✅ API health: all good"}`,
  "",
  `${results.length - failed.length - skipped.length - warned.length} passed · ${failed.length} failed · ${warned.length} warnings · ${skipped.length} skipped`,
  "",
  "| | Check | Detail |",
  "|:--|:--|:--|",
  ...results.map((r) => `| ${icons[r.status]} | ${r.name} | ${r.detail.replace(/\|/g, "\\|")} |`),
  "",
];

if (skipped.length) {
  summary.push(
    "> **Skipped checks** need repository secrets to run in full: `TMDB_API_KEY`, " +
    "`OPENSUBTITLES_API_KEY`, `SUBDL_API_KEY`, `WYZIE_API_KEY`. Without them the endpoints " +
    "are still proven alive and enforcing auth — only the response shapes go unverified.",
    ""
  );
}

console.log("\n" + summary.join("\n"));

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n"));
}

process.exit(failed.length ? 1 : 0);
