// ============================================================
// IINA Plugin: Episode Info  v1.2.1
// ============================================================

const { core, event, overlay, sidebar, utils, file } = iina;

// ── Helpers (new in v1.2.1) ──────────────────────────────────
// Convert any thrown value / API error payload into a readable string.
// Without this, sidebars could show "Error: [object Object]".
function errStr(e) {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === "object") {
    if (typeof e.message === "string") return e.message;
    if (typeof e.reason  === "string") return e.reason;
    if (e.error)              return errStr(e.error);
    if (e.data && e.data.message) return String(e.data.message);
    try { return JSON.stringify(e); } catch(_) { return "Error"; }
  }
  return String(e);
}

// Quote a string for safe inclusion inside a /bin/sh -c command. Wraps the
// arg in single quotes and escapes any embedded single quotes.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Race an HTTP promise against a timeout so search never hangs forever.
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise(function(_, reject) {
      setTimeout(function() {
        reject(new Error((label || "Request") + " timed out after " + Math.round(ms/1000) + "s"));
      }, ms);
    })
  ]);
}
var HTTP_TIMEOUT_MS = 10000; // Per-call budget — sidebar enforces total budget

// OpenSubtitles REQUIRES a User-Agent header formatted as "AppName vX.Y.Z".
// Without it, requests are silently slow-pathed (Cloudflare throttles them),
// which causes timeouts for fresh content even when the result exists.
// Per OS team forum post: "we now require to have User-Agent present in
// requests, set it up to your application/script name with version".
var OS_USER_AGENT = "EpisodeInfo v1.2.1";

// ── Lazy IMDB ID resolver (v1.2.1) ───────────────────────────
// Resolves BOTH the show-level (parent) and episode-level IMDB ids from TMDB.
// The OpenSubtitles team supports two equivalent query patterns:
//   1) ?parent_imdb_id={show}&season_number={s}&episode_number={e}
//   2) ?imdb_id={episode_imdb}&languages=en   (no s/e)
// We resolve both so we can try whichever works.
async function resolveImdbIds(d, tmdbKey) {
  if (!tmdbKey) return d;
  if (!d.tmdbId) return d;

  try {
    if (d.isMovie) {
      if (!d.imdbId) {
        var r = await withTimeout(
          iina.http.get("https://api.themoviedb.org/3/movie/" + d.tmdbId + "/external_ids", {
            params: { api_key: tmdbKey }
          }),
          HTTP_TIMEOUT_MS,
          "TMDB external_ids"
        );
        var body = r.data || JSON.parse(r.text || "{}");
        if (r.statusCode === 200 && body.imdb_id) d.imdbId = body.imdb_id;
      }
    } else {
      // TV: fetch show-level + episode-level in parallel for speed
      var calls = [];
      var needShow = !d.parentImdbId;
      var needEp   = !d.imdbId && d.season && d.episode;

      if (needShow) {
        calls.push(
          withTimeout(
            iina.http.get("https://api.themoviedb.org/3/tv/" + d.tmdbId + "/external_ids", {
              params: { api_key: tmdbKey }
            }),
            HTTP_TIMEOUT_MS,
            "TMDB show external_ids"
          ).then(function(r) {
            var b = r.data || JSON.parse(r.text || "{}");
            if (r.statusCode === 200 && b.imdb_id) d.parentImdbId = b.imdb_id;
          }).catch(function(){})
        );
      }
      if (needEp) {
        calls.push(
          withTimeout(
            iina.http.get("https://api.themoviedb.org/3/tv/" + d.tmdbId
              + "/season/" + d.season + "/episode/" + d.episode + "/external_ids", {
              params: { api_key: tmdbKey }
            }),
            HTTP_TIMEOUT_MS,
            "TMDB episode external_ids"
          ).then(function(r) {
            var b = r.data || JSON.parse(r.text || "{}");
            if (r.statusCode === 200 && b.imdb_id) d.imdbId = b.imdb_id;
          }).catch(function(){})
        );
      }
      if (calls.length) await Promise.all(calls);
    }
  } catch(_e) {}
  return d;
}

// Strip "tt" prefix and leading zeros — OpenSubtitles requires this per
// their docs. Wyzie wants the "tt" prefix preserved, handled separately.
function stripTtAndZeros(s) {
  if (!s) return null;
  var n = String(s).replace(/^tt/i, "").replace(/^0+/, "");
  return n || null;
}

// Plain "tt" prefix preserve (for Wyzie). Strips leading zeros from the
// numeric part but keeps the prefix.
function withTtPrefix(s) {
  if (!s) return null;
  var n = stripTtAndZeros(s);
  return n ? ("tt" + n) : null;
}

var sidebarLoaded      = false;
var currentEpisode     = null;
var pauseTimer         = null;
var overlayVisible     = false;
var overlayBgOpacity   = 0.72;
var overlayEnabled     = true;   // toggled from sidebar, persisted in sidebar's localStorage
var overlayVerticalPos = 50;     // 0=top, 50=center, 100=bottom (new in v1.2.0)
var pauseDelay         = 3;      // seconds before overlay shows on pause (new in v1.2.0)
var currentVideoUrl    = "";     // url of currently loaded file, sent to sidebar so it can
                                 // restore per-URL TMDB info on re-play (new in v1.2.0)

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

  // Sidebar finished its init and is ready to receive messages.
  // Re-emit the current file's URL so it can do its URL→episode lookup
  // (new in v1.2.0). The original fileChanged from file-loaded may have
  // arrived before sidebar handlers were registered.
  sidebar.onMessage("sidebarReady", function() {
    if (currentVideoUrl) {
      sidebar.postMessage("fileChanged", { url: currentVideoUrl });
    }
  });

  // Open external URL in the user's default browser (v1.2.1).
  // Used for the "View on opensubtitles.org" link — WebView <a target=_blank>
  // doesn't work in IINA, so we round-trip through main.js.
  sidebar.onMessage("openExternalUrl", function(d) {
    if (d && d.url) {
      try {
        if (utils && typeof utils.openURL === "function") {
          utils.openURL(d.url);
        } else if (core && typeof core.openUrl === "function") {
          core.openUrl(d.url);
        } else {
          // Last-ditch fallback: shell out to /usr/bin/open
          utils.exec("/usr/bin/open", [d.url]);
        }
      } catch(e) {
        log("Failed to open URL: " + errStr(e));
      }
    }
  });

  // Eager IMDB resolution (v1.2.1) — fires after episode selection so the
  // opensubtitles.org website link populates without waiting for a search.
  sidebar.onMessage("resolveImdbOnly", async function(d) {
    if (!d || !d.tmdbId) return;
    try {
      var resolved = await resolveImdbIds(d, d.tmdbKey || "");
      sidebar.postMessage("imdbResolved", {
        imdb:       resolved.imdbId       || null,
        parentImdb: resolved.parentImdbId || null
      });
    } catch(e) {
      // silently fail — link just won't populate, no harm
    }
  });

  // ── Wyzie Subs ──────────────────────────────────────────────
  sidebar.onMessage("searchWyzie", async function(d) {
    async function wzCall(idParam, includeSE) {
      var params = {
        id:       idParam,
        language: d.lang || "en",
        format:   "srt",
        key:      d.key
      };
      if (includeSE) {
        if (d.season)  params.season  = String(d.season);
        if (d.episode) params.episode = String(d.episode);
      }
      try {
        var resp = await withTimeout(
          iina.http.get("https://sub.wyzie.ru/search", {
            params:  params,
            headers: { "Accept": "application/json" }
          }),
          HTTP_TIMEOUT_MS,
          "Wyzie search"
        );
        var body = resp.data || JSON.parse(resp.text || "[]");
        if (resp.statusCode === 200) {
          var arr = Array.isArray(body) ? body : (body.results || []);
          return { results: arr, status: 200 };
        }
        var msg = (!Array.isArray(body) && body && body.message)
          ? errStr(body.message) : ("HTTP " + resp.statusCode);
        return { error: msg, status: resp.statusCode };
      } catch(e) {
        return { error: errStr(e) };
      }
    }

    function progress(msg) {
      sidebar.postMessage("wyzieSearchProgress", { text: msg });
    }

    try {
      var includeSE = !d.broadShow && !d.isMovie && d.season && d.episode;
      var tried     = [];
      var lastErr   = null;
      var attempt = async function(label, idParam, useSE) {
        if (!idParam) return null;
        progress(label + "…");
        var r = await wzCall(idParam, useSE);
        tried.push(label);
        if (r.error) { lastErr = r.error; return null; }
        if (r.results && r.results.length) return r.results;
        return null;
      };

      var results = null;

      // Wyzie cascade per their docs (sub.wyzie.io):
      //   "Search by IMDB / TMDB ID — /search?id=tt3659388 or /search?id=286217"
      // Plain TMDB id usually works fastest because Wyzie's internal cache
      // is keyed on it. IMDB fallback handles the case where Wyzie failed
      // its own internal TMDB→IMDB resolve (e.g. very new shows).

      // 1) TMDB id (existing behavior, fastest path for known content)
      if (d.tmdbId && !results) {
        results = await attempt("TMDB lookup", String(d.tmdbId), includeSE);
      }

      // 2) IMDB fallback — resolve from TMDB if not already cached
      if (!results) {
        d = await resolveImdbIds(d, d.tmdbKey || "");
        var imdbForWyzie = withTtPrefix(d.parentImdbId || (d.isMovie ? d.imdbId : null));
        if (imdbForWyzie) {
          results = await attempt("IMDB lookup", imdbForWyzie, includeSE);
        }
      }

      // 3) Last-ditch: TMDB id without season/episode (whole-show)
      //    Only relevant for TV when the user didn't already request broadShow.
      if (!results && !d.broadShow && !d.isMovie && d.tmdbId && includeSE) {
        results = await attempt("Whole-show fallback", String(d.tmdbId), false);
      }

      sidebar.postMessage("wyzieSearchResult", {
        results: results || [],
        triedSteps: tried,
        error: (results === null && lastErr) ? lastErr : null,
        resolvedImdb: d.imdbId || null,
        resolvedParentImdb: d.parentImdbId || null
      });
    } catch(e) {
      sidebar.postMessage("wyzieSearchResult", { error: errStr(e) });
    }
  });

  sidebar.onMessage("loadWyzieSub", function(d) {
    if (d && d.url) {
      try {
        iina.mpv.command("sub-add", [d.url, "select"]);
        log("Subtitle loaded");
        sidebar.postMessage("wyzieLoadResult", { success: true });
      } catch(e) {
        sidebar.postMessage("wyzieLoadResult", { success: false, error: errStr(e) });
      }
    }
  });

  // ── SubDL (v1.2.1) ──────────────────────────────────────────
  // SubDL is a third subtitle source with a clean modern REST API and
  // independent database from OpenSubtitles. Adds coverage for content
  // that hasn't synced to OS.com yet (very recent episodes, regional
  // releases). API docs: https://subdl.com/api-doc
  sidebar.onMessage("searchSubdl", async function(d) {
    function progress(msg) {
      sidebar.postMessage("subdlSearchProgress", { text: msg });
    }
    async function sdCall(params) {
      params.api_key = d.key;
      try {
        var resp = await withTimeout(
          iina.http.get("https://api.subdl.com/api/v1/subtitles", {
            params:  params,
            headers: { "Accept": "application/json" }
          }),
          HTTP_TIMEOUT_MS,
          "SubDL search"
        );
        var body = resp.data || JSON.parse(resp.text || "{}");
        if (resp.statusCode === 200 && body.status === true) {
          return { results: body.subtitles || [], status: 200 };
        }
        var msg = (body && body.error) ? errStr(body.error) : ("HTTP " + resp.statusCode);
        return { error: msg, status: resp.statusCode };
      } catch(e) {
        return { error: errStr(e) };
      }
    }
    try {
      var lang     = (d.lang || "EN").toUpperCase(); // SubDL uses uppercase codes
      var perPage  = "30"; // max
      var tried    = [];
      var lastErr  = null;
      var attempt = async function(label, params) {
        progress(label + "…");
        params.subs_per_page = perPage;
        var r = await sdCall(params);
        tried.push(label);
        if (r.error) { lastErr = r.error; return null; }
        if (r.results && r.results.length) return r.results;
        return null;
      };

      var results = null;

      // Manual query: independent text search, no episode bias
      if (d.manualQuery) {
        progress("Searching SubDL…");
        var mr = await sdCall({ film_name: d.manualQuery, languages: lang, subs_per_page: perPage });
        if (mr.error) sidebar.postMessage("subdlSearchResult", { error: mr.error });
        else          sidebar.postMessage("subdlSearchResult", { results: mr.results });
        return;
      }

      // Auto-search: resolve IMDB IDs first
      progress("Resolving IMDB ID…");
      d = await resolveImdbIds(d, d.tmdbKey || "");

      if (d.isMovie) {
        // MOVIE cascade
        if (d.tmdbId && !results) {
          var p = { tmdb_id: String(d.tmdbId), type: "movie", languages: lang };
          if (d.year) p.year = String(d.year);
          results = await attempt("TMDB lookup", p);
        }
        if (!results && d.imdbId) {
          // SubDL example response shows imdb_id with "tt" prefix; send same way
          results = await attempt("IMDB lookup", {
            imdb_id:   String(d.imdbId),
            type:      "movie",
            languages: lang
          });
        }
        if (!results && (d.query || d.epTitle || d.showTitle)) {
          var qp = { film_name: d.query || d.epTitle || d.showTitle, type: "movie", languages: lang };
          if (d.year) qp.year = String(d.year);
          results = await attempt("Text search", qp);
        }
      } else {
        // TV cascade
        if (d.tmdbId && d.season && d.episode && !results) {
          results = await attempt("TMDB lookup", {
            tmdb_id:        String(d.tmdbId),
            type:           "tv",
            season_number:  String(d.season),
            episode_number: String(d.episode),
            languages:      lang
          });
        }
        if (!results && d.parentImdbId && d.season && d.episode) {
          results = await attempt("IMDB lookup", {
            imdb_id:        String(d.parentImdbId),
            type:           "tv",
            season_number:  String(d.season),
            episode_number: String(d.episode),
            languages:      lang
          });
        }
        // Fallback: full-season pack (often has subs even when episode-specific doesn't)
        if (!results && d.tmdbId) {
          results = await attempt("Full-season fallback", {
            tmdb_id:     String(d.tmdbId),
            type:        "tv",
            full_season: "1",
            languages:   lang
          });
        }
        // Last-ditch: text search
        if (!results && (d.query || d.showTitle)) {
          var ep = { film_name: d.query || d.showTitle, type: "tv", languages: lang };
          if (d.season)  ep.season_number  = String(d.season);
          if (d.episode) ep.episode_number = String(d.episode);
          results = await attempt("Text search", ep);
        }
      }

      sidebar.postMessage("subdlSearchResult", {
        results: results || [],
        triedSteps: tried,
        error: (results === null && lastErr) ? lastErr : null,
        resolvedImdb: d.imdbId || null,
        resolvedParentImdb: d.parentImdbId || null
      });
    } catch(e) {
      sidebar.postMessage("subdlSearchResult", { error: errStr(e) });
    }
  });

  // SubDL gives ZIP downloads (raw .srt is "coming soon" per their docs).
  // We download the ZIP via http.download into @tmp/, extract using macOS's
  // built-in /usr/bin/unzip, find the subtitle inside, and load it.
  sidebar.onMessage("loadSubdlSub", async function(d) {
    if (!d || !d.url) {
      sidebar.postMessage("subdlLoadResult", { success: false, error: "No URL" });
      return;
    }

    // Tracks where in the pipeline we fail, for actionable error messages
    var step = "starting";

    try {
      // SubDL gives URLs like "/subtitle/3197651-3213944.zip" — prefix with host
      var url = d.url;
      if (url.charAt(0) === "/") url = "https://dl.subdl.com" + url;
      else if (!/^https?:\/\//i.test(url)) url = "https://dl.subdl.com/" + url;

      // Unique stamp to avoid clashes between consecutive downloads
      var stamp = Date.now() + "-" + Math.floor(Math.random() * 1e6);
      var zipPath    = "@tmp/subdl-" + stamp + ".zip";
      var extractDir = "@tmp/subdl-" + stamp;

      // ── Step 1: download ZIP ──────────────────────────────────
      step = "download";
      var downloadedZipAbsPath = await withTimeout(
        iina.http.download(url, zipPath),
        HTTP_TIMEOUT_MS,
        "SubDL download"
      );
      var zipAbs = downloadedZipAbsPath;
      if (!zipAbs && utils && typeof utils.resolvePath === "function") {
        zipAbs = utils.resolvePath(zipPath);
      }
      if (!zipAbs) zipAbs = zipPath;

      // ── Step 2: prepare extract dir ───────────────────────────
      step = "prepare-extract-dir";
      var extractAbs;
      if (utils && typeof utils.resolvePath === "function") {
        extractAbs = utils.resolvePath(extractDir);
      } else {
        extractAbs = String(zipAbs).replace(/\.zip$/i, "");
      }
      var mkdirResult = await utils.exec("/bin/mkdir", ["-p", String(extractAbs)]);
      if (mkdirResult.status !== 0) {
        throw new Error("mkdir failed: " + (mkdirResult.stderr || mkdirResult.stdout || "no output"));
      }

      // ── Step 3: unzip ─────────────────────────────────────────
      // macOS ships Info-ZIP UnZip 6.00, which DOES NOT support `-O` for
      // filename encoding (that was added in 6.10+ on Linux). We use only
      // the universally-supported flags here.
      //   -j: junk paths (flatten so no nested dirs to recurse)
      //   -o: overwrite without prompting
      step = "unzip";
      var execResult = await utils.exec("/usr/bin/unzip", ["-j", "-o", String(zipAbs), "-d", String(extractAbs)]);
      if (execResult.status !== 0) {
        throw new Error("Unzip failed: " + (execResult.stderr || execResult.stdout || ("exit " + execResult.status)));
      }

      // ── Step 4: find subtitle file (handle nested zips too) ───
      step = "find-subtitle";
      var subFile = null;
      var nestedZip = null;

      var lsResult = await utils.exec("/bin/ls", ["-1", String(extractAbs)]);
      var fileNames = [];
      if (lsResult.status === 0 && lsResult.stdout) {
        var lines = lsResult.stdout.split("\n");
        for (var li = 0; li < lines.length; li++) {
          var nm = lines[li].trim();
          if (nm) fileNames.push(nm);
        }
      }

      // First pass: subtitle files
      for (var i1 = 0; i1 < fileNames.length; i1++) {
        if (/\.(srt|ass|ssa|vtt|sub)$/i.test(fileNames[i1])) {
          subFile = String(extractAbs) + "/" + fileNames[i1];
          break;
        }
      }
      // Second pass: nested zip
      if (!subFile) {
        for (var i2 = 0; i2 < fileNames.length; i2++) {
          if (/\.zip$/i.test(fileNames[i2])) {
            nestedZip = String(extractAbs) + "/" + fileNames[i2];
            break;
          }
        }
      }
      if (!subFile && nestedZip) {
        var nested2 = String(extractAbs) + "/inner";
        await utils.exec("/bin/mkdir", ["-p", nested2]);
        var unzip2 = await utils.exec("/usr/bin/unzip", ["-j", "-o", nestedZip, "-d", nested2]);
        if (unzip2.status === 0) {
          var ls2 = await utils.exec("/bin/ls", ["-1", nested2]);
          if (ls2.status === 0 && ls2.stdout) {
            var ll = ls2.stdout.split("\n");
            for (var i3 = 0; i3 < ll.length; i3++) {
              var nm2 = ll[i3].trim();
              if (/\.(srt|ass|ssa|vtt|sub)$/i.test(nm2)) {
                subFile = nested2 + "/" + nm2;
                break;
              }
            }
          }
        }
      }
      if (!subFile) {
        throw new Error("No subtitle (.srt/.ass/.ssa/.vtt) found inside the zip" + (fileNames.length ? " — got: " + fileNames.join(", ") : ""));
      }

      // ── Step 5: validate the file is non-empty ────────────────
      // Just a sanity check — if the file is 0 bytes the unzip silently
      // failed, which mpv will translate into "Unsupported external subtitle".
      step = "validate";
      var statResult = await utils.exec("/usr/bin/stat", ["-f", "%z", String(subFile)]);
      var fileSize = parseInt((statResult.stdout || "0").trim(), 10);
      if (!fileSize || fileSize < 10) {
        throw new Error("Extracted subtitle is empty or too small (" + fileSize + " bytes)");
      }

      // ── Step 6: load via sub-add and force-select ─────────────
      // mpv handles encoding (incl. BOMs and CP1252) on its own — no need
      // to pre-process the file. This matches what OS/Wyzie do — they
      // hand mpv a path/URL and let mpv parse it.
      step = "sub-add";
      var loaded = false;
      try {
        if (core && core.subtitle && typeof core.subtitle.loadTrack === "function") {
          core.subtitle.loadTrack(subFile);
          loaded = true;
        }
      } catch(_e) { /* fall through to mpv command */ }

      if (!loaded) {
        iina.mpv.command("sub-add", [subFile, "select"]);
        // Explicitly switch sid to the just-added track in case the
        // `select` flag didn't take (happens when there's already an
        // active default track)
        try {
          var tracks = iina.mpv.getNative ? iina.mpv.getNative("track-list") : null;
          if (tracks && tracks.length) {
            var maxSid = 0;
            for (var ti = 0; ti < tracks.length; ti++) {
              var t = tracks[ti];
              if (t && t.type === "sub" && typeof t.id === "number" && t.id > maxSid) {
                maxSid = t.id;
              }
            }
            if (maxSid > 0) {
              try { iina.mpv.set("sid", maxSid); } catch(_e2) {}
            }
          }
        } catch(_e3) { /* best effort */ }
      }

      log("SubDL subtitle loaded from " + subFile);
      sidebar.postMessage("subdlLoadResult", { success: true });
    } catch(e) {
      log("SubDL load failed at step '" + step + "': " + errStr(e));
      sidebar.postMessage("subdlLoadResult", {
        success: false,
        error:   "[" + step + "] " + errStr(e)
      });
    }
  });

  // ── OpenSubtitles ───────────────────────────────────────────
  sidebar.onMessage("osLogin", async function(d) {
    try {
      var resp = await withTimeout(
        iina.http.post("https://api.opensubtitles.com/api/v1/login", {
          headers: {
            "Api-Key":      d.key,
            "Content-Type": "application/json",
            "User-Agent":   OS_USER_AGENT  // v1.2.1: required by OS
          },
          data:    { username: d.username, password: d.password }
        }),
        HTTP_TIMEOUT_MS,
        "OpenSubtitles login"
      );
      var body = resp.data || JSON.parse(resp.text || "{}");
      if (resp.statusCode === 200 && body.token) {
        sidebar.postMessage("osLoginResult", { success: true, token: body.token, username: d.username, downloads: body.user ? body.user.allowed_downloads : null });
      } else {
        var msg = (body && typeof body.message === "string") ? body.message : ("HTTP " + resp.statusCode);
        sidebar.postMessage("osLoginResult", { success: false, error: msg });
      }
    } catch(e) {
      sidebar.postMessage("osLoginResult", { success: false, error: errStr(e) });
    }
  });

  sidebar.onMessage("searchSubs", async function(d) {
    // Helper to fire a single OS API call; returns {results, error, status}
    async function osCall(params, hdrs) {
      try {
        var resp = await withTimeout(
          iina.http.get("https://api.opensubtitles.com/api/v1/subtitles", {
            params: params, headers: hdrs
          }),
          HTTP_TIMEOUT_MS,
          "OpenSubtitles search"
        );
        var body = resp.data || JSON.parse(resp.text || "{}");
        if (resp.statusCode === 200) {
          return { results: body.data || [], status: 200 };
        }
        return { error: (body && body.message) || ("HTTP " + resp.statusCode), status: resp.statusCode };
      } catch(e) {
        return { error: errStr(e) };
      }
    }

    function progress(msg) {
      sidebar.postMessage("subSearchProgress", { text: msg });
    }

    try {
      var hdrs = { "Api-Key": d.key, "User-Agent": OS_USER_AGENT };
      if (d.token) hdrs["Authorization"] = "Bearer " + d.token;
      var lang  = d.lang || "en";

      // ── Manual query: completely independent ──────────────────
      // No saved-episode params bleed in. Pure text search.
      if (d.manualQuery) {
        progress("Searching OpenSubtitles…");
        var mq = await osCall({ query: d.manualQuery, languages: lang }, hdrs);
        if (mq.error) sidebar.postMessage("subSearchResult", { error: mq.error });
        else          sidebar.postMessage("subSearchResult", { results: mq.results });
        return;
      }

      // ── Auto-search: resolve show/movie IMDB id, then cascade ──
      progress("Resolving IMDB ID…");
      d = await resolveImdbIds(d, d.tmdbKey || "");

      var tried   = [];
      var lastErr = null;
      var attempt = async function(label, params) {
        progress(label + "…");
        var r = await osCall(params, hdrs);
        tried.push(label);
        if (r.error) { lastErr = r.error; return null; }
        if (r.results && r.results.length) return r.results;
        return null;
      };

      var results = null;

      if (d.isMovie) {
        // MOVIE cascade:
        //   1) imdb_id (with leading zeros stripped) — most precise
        //   2) tmdb_id + year — TMDB fallback
        //   3) text query + year + type=movie — last-ditch
        var movieImdb = stripTtAndZeros(d.imdbId);
        if (movieImdb && !results) {
          results = await attempt("IMDB lookup", { imdb_id: movieImdb, languages: lang });
        }
        if (!results && d.tmdbId) {
          var p = { tmdb_id: String(d.tmdbId), languages: lang };
          if (d.year) p.year = String(d.year);
          results = await attempt("TMDB lookup", p);
        }
        if (!results && (d.query || d.epTitle || d.showTitle)) {
          var qp = { query: d.query || d.epTitle || d.showTitle, type: "movie", languages: lang };
          if (d.year) qp.year = String(d.year);
          results = await attempt("Text search", qp);
        }
      } else {
        // TV EPISODE cascade — per OpenSubtitles team's documented guidance:
        //   "works best if possible to get the parent id and send the
        //    episode & season numbers"
        //   AND "to get the subtitles for a specific episode by imdbid,
        //    you need to send the episode imdbid, and no episode_number
        //    or season_number"
        //   1) imdb_id={episode_imdb}  (no s/e, episode-level — sometimes works
        //      when parent_imdb_id pattern doesn't, e.g. for very fresh content)
        //   2) parent_imdb_id + season + episode  (recommended pattern)
        //   3) parent_tmdb_id + season + episode  (TMDB fallback)
        //   4) text query + season + episode + type=episode  (last-ditch)
        var epImdb = stripTtAndZeros(d.imdbId);
        if (epImdb && !results) {
          results = await attempt("Episode IMDB lookup", {
            imdb_id:   epImdb,
            languages: lang
          });
        }
        var pImdb = stripTtAndZeros(d.parentImdbId);
        if (!results && pImdb && d.season && d.episode) {
          results = await attempt("Show IMDB lookup", {
            parent_imdb_id: pImdb,
            season_number:  String(d.season),
            episode_number: String(d.episode),
            languages:      lang
          });
        }
        if (!results && d.tmdbId && d.season && d.episode) {
          results = await attempt("TMDB lookup", {
            parent_tmdb_id: String(d.tmdbId),
            season_number:  String(d.season),
            episode_number: String(d.episode),
            languages:      lang
          });
        }
        if (!results && (d.query || d.showTitle)) {
          var ep = { query: d.query || d.showTitle, type: "episode", languages: lang };
          if (d.season)  ep.season_number  = String(d.season);
          if (d.episode) ep.episode_number = String(d.episode);
          results = await attempt("Text search", ep);
        }
      }

      sidebar.postMessage("subSearchResult", {
        results: results || [],
        triedSteps: tried,
        error: (results === null && lastErr) ? lastErr : null,
        resolvedImdb: d.imdbId || null,
        resolvedParentImdb: d.parentImdbId || null
      });
    } catch(e) {
      sidebar.postMessage("subSearchResult", { error: errStr(e) });
    }
  });

  sidebar.onMessage("downloadSub", async function(d) {
    try {
      var hdrs = {
        "Api-Key":      d.key,
        "Content-Type": "application/json",
        "User-Agent":   OS_USER_AGENT  // v1.2.1: required by OS
      };
      if (d.token) hdrs["Authorization"] = "Bearer " + d.token;
      var resp = await withTimeout(
        iina.http.post("https://api.opensubtitles.com/api/v1/download", {
          headers: hdrs, data: { file_id: d.file_id }
        }),
        HTTP_TIMEOUT_MS,
        "OpenSubtitles download"
      );
      var body = resp.data || JSON.parse(resp.text || "{}");
      if (resp.statusCode === 200 && body.link) {
        iina.mpv.command("sub-add", [body.link, "select"]);
        sidebar.postMessage("subDownloadResult", { success: true, remaining: typeof body.remaining === "number" ? body.remaining : null });
      } else {
        sidebar.postMessage("subDownloadResult", { success: false, error: (body && body.message) || ("HTTP " + resp.statusCode) });
      }
    } catch(e) {
      sidebar.postMessage("subDownloadResult", { success: false, error: errStr(e) });
    }
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
