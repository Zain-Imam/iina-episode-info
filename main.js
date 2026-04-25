// ============================================================
// IINA Plugin: Episode Info  v1.2.0
// ============================================================

const { core, event, overlay, sidebar } = iina;

var sidebarLoaded      = false;
var currentEpisode     = null;
var pauseTimer         = null;
var overlayVisible     = false;
var overlayBgOpacity   = 0.72;
var overlayEnabled     = true;   
var overlayVerticalPos = 50;     
var pauseDelay         = 3;      
var currentVideoUrl    = "";     
                                 

function log(msg) {
  iina.console.log("[EpInfo] " + msg);
  if (sidebarLoaded) sidebar.postMessage("overlayStatus", { text: msg });
}

function showOverlay(d) {
  if (!overlayEnabled) return;
  overlay.postMessage("showData", {
    showTitle:   d.showTitle  || "",
    epTitle:     d.epTitle    || "",
    code:        d.code       || "",
    airDate:     d.airDate    || "",
    rating:      d.rating     || "",
    overview:    d.overview   || "",
    posterUrl:   d.posterUrl  || "",
    bgOpacity:   overlayBgOpacity,
    verticalPos: overlayVerticalPos
  });
  overlay.show();
  overlayVisible = true;
  sidebar.postMessage("overlayShowing", { visible: true });
  log("Showing: " + d.epTitle);
}

function hideOverlay() {
  if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
  overlay.hide();
  overlayVisible = false;
  sidebar.postMessage("overlayShowing", { visible: false });
}

// ── Sidebar handlers ──────────────────────────────────────────
function registerSidebarHandlers() {

  sidebar.onMessage("episodeSelected", function(info) {
    log("episodeSelected: " + (info ? info.epTitle : "null"));
    currentEpisode = info;
  });

  sidebar.onMessage("clearEpisode", function() {
    currentEpisode = null;
    hideOverlay();
  });

  sidebar.onMessage("overlayCloseRequest", function() {
    hideOverlay();
  });

  // ON/OFF toggle from sidebar
  sidebar.onMessage("setOverlayEnabled", function(d) {
    overlayEnabled = !!d.enabled;
    if (!overlayEnabled) hideOverlay();
    log("Overlay " + (overlayEnabled ? "enabled" : "disabled"));
  });

  // Opacity slider
  sidebar.onMessage("setOverlayOpacity", function(d) {
    var v = parseFloat(d.value);
    if (isNaN(v)) return;
    overlayBgOpacity = Math.max(0, Math.min(1, v));
    if (overlayVisible) overlay.postMessage("setBgOpacity", { value: overlayBgOpacity });
  });

  // Vertical position slider (new in v1.2.0)
  sidebar.onMessage("setOverlayVerticalPos", function(d) {
    var v = parseFloat(d.value);
    if (!isNaN(v)) {
      overlayVerticalPos = Math.max(0, Math.min(100, v));
      if (overlayVisible) overlay.postMessage("setVerticalPos", { value: overlayVerticalPos });
    }
  });

  // Configurable pause delay (new in v1.2.0)
  sidebar.onMessage("setPauseDelay", function(d) {
    var v = parseFloat(d.value);
    if (!isNaN(v) && v >= 0.5) pauseDelay = v;
  });
  
  sidebar.onMessage("sidebarReady", function() {
    if (currentVideoUrl) {
      sidebar.postMessage("fileChanged", { url: currentVideoUrl });
    }
  });

  // ── Wyzie Subs ──────────────────────────────────────────────
  sidebar.onMessage("searchWyzie", async function(d) {
    try {
      var params = {
        id:       d.tmdbId,
        language: d.lang || "en",
        format:   "srt",
        source:   "all",
        key:      d.key
      };
      if (d.season)  params.season  = String(d.season);
      if (d.episode) params.episode = String(d.episode);

      var resp = await iina.http.get("https://sub.wyzie.ru/search", {
        params:  params,
        headers: { "Accept": "application/json" }
      });
      var body = resp.data || JSON.parse(resp.text || "[]");
      if (resp.statusCode === 200) {
        var results = Array.isArray(body) ? body : (body.results || []);
        sidebar.postMessage("wyzieSearchResult", { results: results });
      } else {
        var errMsg = (!Array.isArray(body) && body && body.message) ? body.message : ("HTTP " + resp.statusCode);
        sidebar.postMessage("wyzieSearchResult", { error: errMsg });
      }
    } catch(e) {
      sidebar.postMessage("wyzieSearchResult", { error: String(e) });
    }
  });

  sidebar.onMessage("loadWyzieSub", function(d) {
    if (d && d.url) {
      try {
        iina.mpv.command("sub-add", [d.url, "select"]);
        log("Subtitle loaded");
        sidebar.postMessage("wyzieLoadResult", { success: true });
      } catch(e) {
        sidebar.postMessage("wyzieLoadResult", { success: false, error: String(e) });
      }
    }
  });

  // ── OpenSubtitles ───────────────────────────────────────────
  sidebar.onMessage("osLogin", async function(d) {
    try {
      var resp = await iina.http.post("https://api.opensubtitles.com/api/v1/login", {
        headers: { "Api-Key": d.key, "Content-Type": "application/json" },
        data: { username: d.username, password: d.password }
      });
      var body = resp.data || JSON.parse(resp.text || "{}");
      if (resp.statusCode === 200 && body.token) {
        sidebar.postMessage("osLoginResult", { success: true, token: body.token, username: d.username, downloads: body.user ? body.user.allowed_downloads : null });
      } else {
        var msg = (body && typeof body.message === "string") ? body.message : ("HTTP " + resp.statusCode);
        sidebar.postMessage("osLoginResult", { success: false, error: msg });
      }
    } catch(e) {
      var errMsg = (e && e.data && e.data.message) ? e.data.message
                 : (e && e.reason)                  ? e.reason
                 : (e && e.message)                 ? e.message
                 : (typeof e === "string")           ? e
                 : JSON.stringify(e);
      sidebar.postMessage("osLoginResult", { success: false, error: errMsg });
    }
  });

  sidebar.onMessage("searchSubs", async function(d) {
    try {
      var params = { query: d.query, languages: d.lang || "en", type: d.isMovie ? "movie" : "episode" };
      if (d.season)  params.season_number  = String(d.season);
      if (d.episode) params.episode_number = String(d.episode);
      var hdrs = { "Api-Key": d.key };
      if (d.token) hdrs["Authorization"] = "Bearer " + d.token;
      var resp = await iina.http.get("https://api.opensubtitles.com/api/v1/subtitles", { params: params, headers: hdrs });
      var body = resp.data || JSON.parse(resp.text || "{}");
      if (resp.statusCode === 200) {
        sidebar.postMessage("subSearchResult", { results: body.data || [] });
      } else {
        sidebar.postMessage("subSearchResult", { error: (body && body.message) || ("HTTP " + resp.statusCode) });
      }
    } catch(e) { sidebar.postMessage("subSearchResult", { error: String(e) }); }
  });

  sidebar.onMessage("downloadSub", async function(d) {
    try {
      var hdrs = { "Api-Key": d.key, "Content-Type": "application/json" };
      if (d.token) hdrs["Authorization"] = "Bearer " + d.token;
      var resp = await iina.http.post("https://api.opensubtitles.com/api/v1/download", { headers: hdrs, data: { file_id: d.file_id } });
      var body = resp.data || JSON.parse(resp.text || "{}");
      if (resp.statusCode === 200 && body.link) {
        iina.mpv.command("sub-add", [body.link, "select"]);
        sidebar.postMessage("subDownloadResult", { success: true, remaining: typeof body.remaining === "number" ? body.remaining : null });
      } else {
        sidebar.postMessage("subDownloadResult", { success: false, error: (body && body.message) || ("HTTP " + resp.statusCode) });
      }
    } catch(e) { sidebar.postMessage("subDownloadResult", { success: false, error: String(e) }); }
  });

  sidebar.onMessage("clearSub", function() {
    try { iina.mpv.set("sid", "no"); } catch(e) {}
  });
}

function setupSidebar() {
  if (!sidebarLoaded) {
    sidebar.loadFile("sidebar.html");
    sidebarLoaded = true;
    setTimeout(registerSidebarHandlers, 500);
  }
}

// ── Events ────────────────────────────────────────────────────
event.on("iina.window-loaded", function() {
  overlay.loadFile("overlay.html");
  overlay.onMessage("closeOverlay", function() { hideOverlay(); });
  setupSidebar();
});

event.on("iina.file-loaded", function() {
  setupSidebar();
  currentEpisode = null;
  hideOverlay();
  // Capture URL so sidebar can look it up in its URL→episode map (new in v1.2.0)
  try { currentVideoUrl = core.status.url || ""; } catch(e) { currentVideoUrl = ""; }
  sidebar.postMessage("fileChanged", { url: currentVideoUrl });
  sidebar.postMessage("overlayStatus", { text: "Select an episode, then pause" });
});

event.on("mpv.pause.changed", function() {
  if (core.status.paused) {
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    if (!overlayEnabled) return;
    if (currentEpisode) {
      pauseTimer = setTimeout(function() {
        pauseTimer = null;
        if (core.status.paused && currentEpisode) showOverlay(currentEpisode);
      }, pauseDelay * 1000);
    } else {
      log("Paused — no episode selected");
    }
  } else {
    hideOverlay();
  }
});
