// IINA Plugin: Episode Info v1.3.2

const { core, event, utils, file, menu } = iina;
// Messages to the overlay and sidebar go through messageSafe()
const overlay = safeMessenger(iina.overlay, ["loadFile", "onMessage", "show", "hide", "setClickable"]);
const sidebar = safeMessenger(iina.sidebar, ["loadFile", "onMessage"]);

// Helpers
// IINA passes messages to web views inside a JS template literal, so a backtick or ${ would break them
function messageSafe(v) {
  if (typeof v === "string") return v.replace(/`/g, "\u02CB").replace(/\$\{/g, "$\u200B{");
  if (Array.isArray(v)) return v.map(messageSafe);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    var out = {};
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = messageSafe(v[k]);
    }
    return out;
  }
  return v;
}

// Wraps iina.overlay / iina.sidebar so postMessage goes through messageSafe()
function safeMessenger(target, methods) {
  var m = {};
  methods.forEach(function(name) {
    m[name] = function() { return target[name].apply(target, arguments); };
  });
  m.postMessage = function(name, data) { return target.postMessage(name, messageSafe(data)); };
  return m;
}

// Turn any thrown value or API error into a readable string
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

// Quote a string for /bin/sh -c
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
var HTTP_TIMEOUT_MS = 10000; // per-call budget

// OpenSubtitles needs a User-Agent like "AppName vX.Y.Z" or it throttles requests
var OS_USER_AGENT = "EpisodeInfo v1.3.2";

// Lazy IMDB id resolver: show-level and episode-level ids from TMDB
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
      // TV: show and episode ids in parallel
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

// OpenSubtitles wants the "tt" prefix and leading zeros stripped
function stripTtAndZeros(s) {
  if (!s) return null;
  var n = String(s).replace(/^tt/i, "").replace(/^0+/, "");
  return n || null;
}

// Canonical IMDB id, leading zeros kept: the skip databases need it exact
function canonicalImdb(s) {
  if (!s) return null;
  var t = String(s).trim();
  if (!t) return null;
  return /^tt/i.test(t) ? t : ("tt" + t);
}

// Keeps the "tt" prefix, strips leading zeros (for Wyzie)
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
var overlayEnabled     = true; // set from the sidebar
var overlayVerticalPos = 50;     // 0=top, 50=center, 100=bottom
var pauseDelay         = 3;      // seconds before overlay shows on pause
var overlayTheme       = "classic"; // classic | compact | poster
var skipEnabled        = false;  // opt-in: skip intro/recap/credits
var cardVisible        = false;  // info card showing?
var skipVisible        = false;  // skip pill showing?
var segments           = [];     // resolved skip segments for this file
var activeSegment      = null;   // the one the pill is currently offering
var timeWatcher        = null;   // id of the mpv.time-pos observer
var tmdbKey            = ""; // pushed from the sidebar
var segmentCache       = {};     // "imdb:season:episode" -> segments
var currentVideoUrl    = ""; // url of the current file, for the sidebar's per-URL memory

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
    verticalPos: overlayVerticalPos,
    theme:       overlayTheme
  });
  overlay.show();
  cardVisible = true;
  overlayVisible = true;
  sidebar.postMessage("overlayShowing", { visible: true });
  log("Showing: " + d.epTitle);
}

function hideOverlay() {
  if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
  cardVisible = false;
  overlayVisible = false;
  overlay.postMessage("hideCard", {});
  syncOverlay();
  sidebar.postMessage("overlayShowing", { visible: false });
}

// The info card and skip pill share the overlay; hide it only when neither is up
function syncOverlay() {
  if (cardVisible || skipVisible) overlay.show();
  else overlay.hide();
}

// Skip intro / recap / credits: chapters first, then the databases. Never seeks on its own.

var SEGMENT_LABELS = {
  intro:   "Skip Intro",
  recap:   "Skip Recap",
  outro:   "Skip Credits",
  credits: "Skip Credits",
  preview: "Skip Preview"
};

// Crowdsourced data contains reversed and zero-length ranges.
function validSegment(seg) {
  return seg && isFinite(seg.start) && isFinite(seg.end) &&
         seg.end > seg.start && seg.end - seg.start >= 3;
}

function pushSegment(list, kind, start, end, source, opts) {
  var seg = {
    kind: kind, start: Number(start), end: Number(end), source: source,
    // A value guessed from a null is a placeholder, not a measurement
    preciseStart: !(opts && opts.vagueStart),
    preciseEnd:   !(opts && opts.vagueEnd)
  };
  if (validSegment(seg)) list.push(seg);
}

// 1. Chapters: each one ends where the next begins
function segmentsFromChapters() {
  var out = [];
  try {
    var chapters = core.getChapters() || [];
    if (chapters.length < 2) return out;
    var duration = 0;
    try { duration = iina.mpv.getNumber("duration") || 0; } catch(e) {}

    for (var i = 0; i < chapters.length; i++) {
      var title = String(chapters[i].title || "").trim();
      var end   = (i + 1 < chapters.length) ? chapters[i + 1].start : duration;
      if (!end) continue;
      if (/^(op|opening|intro|avant|titles?|opening credits)$/i.test(title)) {
        pushSegment(out, "intro", chapters[i].start, end, "chapters");
      } else if (/^(recap|previously)/i.test(title)) {
        pushSegment(out, "recap", chapters[i].start, end, "chapters");
      } else if (/^(ed|ending|outro|credits|end credits)$/i.test(title)) {
        pushSegment(out, "outro", chapters[i].start, end, "chapters");
      }
    }
  } catch(e) {}
  return out;
}

// 2. The databases, keyed on IMDB id + season + episode
async function segmentsFromApis(imdbId, season, episode) {
  var out = [];
  if (!imdbId) return out;

  var qs = "imdb_id=" + encodeURIComponent(imdbId);
  if (season)  qs += "&season=" + encodeURIComponent(season);
  if (episode) qs += "&episode=" + encodeURIComponent(episode);

  async function grab(label, url, parse) {
    try {
      var r = await withTimeout(
        iina.http.get(url, { headers: { "Accept": "application/json" } }),
        HTTP_TIMEOUT_MS, label
      );
      if (r.statusCode !== 200) return;
      var body = r.data || JSON.parse(r.text || "{}");
      parse(body);
    } catch(e) { /* one dead provider must not break the others */ }
  }

  await Promise.all([
    // IntroDB — /segments returns every type; /intro is intros-only.
    grab("IntroDB", "https://api.introdb.app/segments?" + qs, function(b) {
      ["intro", "recap", "outro"].forEach(function(k) {
        if (b[k]) pushSegment(out, k, b[k].start_sec, b[k].end_sec, "introdb");
      });
    }),
    // TheIntroDB: start_ms/end_ms may be null (from the start / to the end)
    grab("TheIntroDB", "https://api.theintrodb.org/v2/media?" + qs, function(b) {
      var dur = 0;
      try { dur = iina.mpv.getNumber("duration") || 0; } catch(e) {}
      [["intro", "intro"], ["credits", "outro"]].forEach(function(pair) {
        var arr = b[pair[0]];
        if (!Array.isArray(arr)) return;
        arr.forEach(function(x) {
          var vagueStart = (x.start_ms === null || x.start_ms === undefined);
          var vagueEnd   = (x.end_ms   === null || x.end_ms   === undefined);
          var st = vagueStart ? 0   : x.start_ms / 1000;
          var en = vagueEnd   ? dur : x.end_ms   / 1000;
          pushSegment(out, pair[1], st, en, "theintrodb",
                      { vagueStart: vagueStart, vagueEnd: vagueEnd });
        });
      });
    }),
    // SkipDB — 200 with null members when it has nothing.
    grab("SkipDB", "https://api.skipdb.tv/api/segments?" + qs, function(b) {
      var segs = b.segments || {};
      ["intro", "recap", "outro", "preview"].forEach(function(k) {
        var x = segs[k];
        if (!x) return;
        if (typeof x.confidence === "number" && x.confidence < 0.5) return;
        pushSegment(out, k, x.start_ms / 1000, x.end_ms / 1000, "skipdb");
      });
    })
  ]);

  return out;
}

// AniSkip uses MyAnimeList ids, so map the IMDB id through ARM first
async function malIdFor(imdbTt, season) {
  try {
    var r = await withTimeout(
      iina.http.get("https://arm.haglund.dev/api/v2/imdb", {
        params: { id: imdbTt, include: "myanimelist" },
        headers: { "Accept": "application/json" }
      }), HTTP_TIMEOUT_MS, "ARM lookup");
    if (r.statusCode !== 200) return null;
    var arr = r.data || JSON.parse(r.text || "[]");
    if (!Array.isArray(arr) || !arr.length) return null;      // not anime
    var e = arr[(Number(season) || 1) - 1] || arr[0];
    return e && e.myanimelist ? String(e.myanimelist) : null;
  } catch(e) { return null; }
}

async function segmentsFromAniSkip(malId, episode) {
  var out = [];
  try {
    var url = "https://api.aniskip.com/v2/skip-times/" + encodeURIComponent(malId) +
              "/" + encodeURIComponent(episode || 1) +
              "?types[]=op&types[]=ed&types[]=recap&episodeLength=0";
    var r = await withTimeout(
      iina.http.get(url, { headers: { "Accept": "application/json" } }),
      HTTP_TIMEOUT_MS, "AniSkip");
    if (r.statusCode !== 200) return out;
    var body = r.data || JSON.parse(r.text || "{}");
    if (!body.found || !Array.isArray(body.results)) return out;
    body.results.forEach(function(x) {
      var kind = { op: "intro", "mixed-op": "intro",
                   ed: "outro", "mixed-ed": "outro",
                   recap: "recap" }[String(x.skipType).toLowerCase()];
      if (!kind || !x.interval) return;
      pushSegment(out, kind, x.interval.startTime, x.interval.endTime, "aniskip");
    });
  } catch(e) {}
  return out;
}

// One segment per kind; the stretch most databases agree on wins
var SOURCE_ORDER = { chapters: 0, introdb: 1, theintrodb: 2, skipdb: 3 };

// Overlap as a fraction of the shorter segment: 1 = identical, 0 = disjoint.
function overlapRatio(a, b) {
  var lo = Math.max(a.start, b.start);
  var hi = Math.min(a.end, b.end);
  var ov = hi - lo;
  if (ov <= 0) return 0;
  var shortest = Math.min(a.end - a.start, b.end - b.start);
  return shortest > 0 ? ov / shortest : 0;
}

function median(nums) {
  var a = nums.slice().sort(function(x, y) { return x - y; });
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function distinctSources(group) {
  var seen = {};
  group.forEach(function(s) { seen[s.source] = 1; });
  return Object.keys(seen);
}

function bestRank(group) {
  return Math.min.apply(null, group.map(function(s) {
    var r = SOURCE_ORDER[s.source];
    return r === undefined ? 99 : r;
  }));
}

function mergeSegments(list) {
  var byKind = {};
  list.forEach(function(seg) {
    (byKind[seg.kind] = byKind[seg.kind] || []).push(seg);
  });

  return Object.keys(byKind).map(function(kind) {
    var segs = byKind[kind];

    // Cluster segments that describe the same stretch of video.
    var groups = [];
    segs.forEach(function(seg) {
      for (var i = 0; i < groups.length; i++) {
        for (var j = 0; j < groups[i].length; j++) {
          if (overlapRatio(groups[i][j], seg) > 0.5) { groups[i].push(seg); return; }
        }
      }
      groups.push([seg]);
    });

    // Most corroborated group wins; ties go to the more reliable source.
    groups.sort(function(a, b) {
      var d = distinctSources(b).length - distinctSources(a).length;
      if (d !== 0) return d;
      return bestRank(a) - bestRank(b);
    });
    var win = groups[0];

    // Prefer measured values over placeholders
    var starts = win.filter(function(s) { return s.preciseStart; }).map(function(s) { return s.start; });
    var ends   = win.filter(function(s) { return s.preciseEnd;   }).map(function(s) { return s.end;   });
    if (!starts.length) starts = win.map(function(s) { return s.start; });
    if (!ends.length)   ends   = win.map(function(s) { return s.end;   });

    return {
      kind:    kind,
      // Earliest start, so the button is up before the intro rolls.
      start:   Math.min.apply(null, starts),
      // Median end: overshooting skips real content, and the median resists outliers
      end:     median(ends),
      sources: distinctSources(win),
      agreed:  distinctSources(win).length
    };
  }).filter(validSegment);
}

async function resolveSegments(info, forceRefresh) {
  segments = [];
  activeSegment = null;
  hideSkip();
  if (!skipEnabled || !info) return;

  var local = segmentsFromChapters();
  if (local.length) {
    segments = mergeSegments(local);
    startTimeWatcher();
    reportSkip(info, segments);
    return;
  }

  // Keyed on the show's IMDB id, not the episode's
  function showLevelId() {
    return canonicalImdb(info.isMovie ? info.imdbId : info.parentImdbId);
  }
  var imdb = showLevelId();
  if (!imdb && tmdbKey && info.tmdbId) {
    await resolveImdbIds(info, tmdbKey);
    imdb = showLevelId();
  }
  if (!imdb) { reportSkip(info, []); return; }

  var cacheKey = imdb + ":" + (info.season || 0) + ":" + (info.episode || 0);
  if (segmentCache[cacheKey] && !forceRefresh) {
    segments = segmentCache[cacheKey];
    if (segments.length) startTimeWatcher();
    reportSkip(info, segments);
    return;
  }

  // Anime first: AniSkip is more precise for openings and endings
  var mal = await malIdFor(imdb, info.season);
  var anime = mal ? await segmentsFromAniSkip(mal, info.episode) : [];

  var remote = await segmentsFromApis(imdb, info.season, info.episode);
  var merged = mergeSegments(remote);

  // AniSkip wins per kind; the rest falls back to the TV databases
  if (anime.length) {
    var byKind = {};
    mergeSegments(anime).forEach(function(x) { byKind[x.kind] = x; });
    merged.forEach(function(x) { if (!byKind[x.kind]) byKind[x.kind] = x; });
    merged = Object.keys(byKind).map(function(k) { return byKind[k]; });
  }
  segments = merged;
  segmentCache[cacheKey] = segments;
  if (segments.length) startTimeWatcher();
  reportSkip(info, segments);
}

// Lets the sidebar's "Search again" button stop spinning and report.
function reportSkip(info, list) {
  sidebar.postMessage("skipResult", {
    count: list.length,
    label: list.length ? describeSegments(list) : ""
  });
}

var SOURCE_NAMES = {
  chapters:   "chapters",
  introdb:    "IntroDB",
  theintrodb: "TheIntroDB",
  skipdb:     "SkipDB"
};

function fmtTime(sec) {
  var m = Math.floor(sec / 60), ss = Math.floor(sec % 60);
  return m + ":" + (ss < 10 ? "0" : "") + ss;
}

function describeSegments(list) {
  var parts = list.map(function(seg) {
    var name = (SEGMENT_LABELS[seg.kind] || "Skip").replace("Skip ", "");
    return name + " " + fmtTime(seg.start) + "–" + fmtTime(seg.end);
  });
  return "Found: " + parts.join(" · ");
}

function showSkip(seg) {
  activeSegment = seg;
  skipVisible = true;
  overlay.postMessage("showSkip", { label: SEGMENT_LABELS[seg.kind] || "Skip" });
  syncOverlay();
  // Clickable only while the pill is up, so click-to-pause still works
  try { overlay.setClickable(true); } catch(e) { log("setClickable(true) failed: " + errStr(e)); }
}

// Reachable from the overlay button, the Plugins menu and Alt+S.
function skipNow(via) {
  if (!activeSegment) {
    return;
  }
  var target = activeSegment.end;
  var kind   = activeSegment.kind;
  hideSkip();

  var how = "";
  try {
    core.seekTo(target);
    how = "core.seekTo";
  } catch(e1) {
    try {
      iina.mpv.command("seek", [String(target), "absolute", "exact"]);
      how = "mpv seek absolute";
    } catch(e2) {
      try {
        iina.mpv.set("time-pos", target);
        how = "mpv time-pos";
      } catch(e3) {
        iina.console.log("[EpInfo] seek failed: " + errStr(e1) + " / " + errStr(e2) + " / " + errStr(e3));
        return;
      }
    }
  }

  var what = { intro: "intro", recap: "recap", outro: "credits",
               credits: "credits", preview: "preview" }[kind] || kind;
  iina.console.log("[EpInfo] skipped " + kind + " to " + target + "s via " + how + " (" + via + ")");

}

function hideSkip() {
  if (!skipVisible) return;
  activeSegment = null;
  skipVisible = false;
  overlay.postMessage("hideSkip", {});
  try { overlay.setClickable(false); } catch(e) { log("setClickable(false) failed: " + errStr(e)); }
  syncOverlay();
}

// Follows time-pos instead of a timer, which would drift while paused or after a seek
function startTimeWatcher() {
  if (timeWatcher) return;
  timeWatcher = event.on("mpv.time-pos.changed", function() {
    if (!skipEnabled || !segments.length) return;
    var t;
    try { t = iina.mpv.getNumber("time-pos"); } catch(e) { return; }
    if (!isFinite(t)) return;

    var hit = null;
    for (var i = 0; i < segments.length; i++) {
      if (t >= segments[i].start && t < segments[i].end) { hit = segments[i]; break; }
    }
    if (hit) {
      if (activeSegment !== hit) showSkip(hit);
    } else if (skipVisible) {
      hideSkip();
    }
  });
}

function stopTimeWatcher() {
  if (!timeWatcher) return;
  try { event.off("mpv.time-pos.changed", timeWatcher); } catch(e) {}
  timeWatcher = null;
}

// Automatic Lookup (experimental): only runs when the sidebar asks, and answers with a confirmed match or "not sure"

var AL_VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv|flv|webm|ts|m2ts|mts|mpg|mpeg|ogv|3gp|divx|m3u8|iso|rmvb|vob)$/i;
var AL_POSTER = "https://image.tmdb.org/t/p/w500";

// Names that say nothing about what is playing.
var AL_GENERIC = /^(?:video|videos|stream|streams|index|master|playlist|manifest|media|file|files|download|downloads|play|watch|movie|movies|film|films|show|shows|series|tv|episode|episodes|output|chunklist|default|main|untitled|clip|sample|source|content|data|null|undefined|resolve|playback|dl|get|view|preview|original|encoded|new|test|temp|tmp|seg|segment|part|audio)$/i;
// Folder names that are never a show or film.
var AL_FOLDER_DENY = /^(?:users|home|downloads?|movies|films?|tv|tv shows|shows|series|videos?|media|volumes|library|plex|jellyfin|emby|torrents?|complete|completed|incoming|new|private|public|desktop|documents|mnt|data|share|shared|nas|disk ?\d*|drive|storage|anime)$/i;
// Folders that hold extras rather than the film or episode itself.
var AL_EXTRA_FOLDER = /^(?:extras?|featurettes?|trailers?|samples?|behind the scenes|deleted scenes|interviews|shorts|scenes|other|specials?)$/i;
// Trailers, samples and other things that are not the episode or film.
var AL_EXTRA = /\b(?:trailers?|teasers?|sample|featurettes?|behind the scenes|deleted scenes?|making of|bloopers?|gag reel|extras|bonus|promo|ncop|nced|creditless|music video|full movie|reaction|explained|recap|interviews?|soundtrack|ost|opening|ending)\b/i;
// Numbering TMDB does not share: "Final Season", "2nd Season", "Part 2".
var AL_SEASON_WORDS = /\b(?:final season|\d+(?:st|nd|rd|th) season|part \d+|cour \d+)\b/i;
// Tags that end the title. Words like "web" or "complete" are left out, they show up in real titles
var AL_CUT = [
  /\b(?:2160p|1440p|1080p|1080i|720p|576p|480p|4k|uhd)\b/i,
  /\b(?:blu-?ray|bdrip|brrip|bdremux|remux|web-?dl|webrip|hdtv|pdtv|dvdrip|hdrip|dvdscr|hdcam|camrip|telesync|hdts)\b/i,
  /\b(?:x26[45]|h ?26[45]|hevc|xvid|divx|av1)\b/i,
  /\b(?:dts(?:-?hd)?|truehd|atmos|e?ac3|ddp?\d|dd\+|aac\d?)\b/i,
  /\b(?:hdr10\+?|hdr|dolby ?vision|dovi|10 ?bit|8 ?bit)\b/i,
  /\b(?:proper|repack|rerip|internal|extended|unrated|uncut|remastered|imax|multi|dual[ -]audio|vostfr|subbed|dubbed)\b/i,
  /\b(?:amzn|dsnp|hmax|atvp|pcok)\b/i
];

function alPad2(n) { return (n < 10 ? "0" : "") + n; }

function alDecode(s, plusIsSpace) {
  var t = String(s == null ? "" : s);
  if (plusIsSpace) t = t.replace(/\+/g, " ");
  // Links are sometimes encoded twice.
  for (var i = 0; i < 2 && /%[0-9a-f]{2}/i.test(t); i++) {
    try { t = decodeURIComponent(t); } catch (e) { break; }
  }
  return t;
}

// Split a link or local path by hand; IINA's JSContext has no URL class
function alSplitLink(link) {
  var s = String(link || "");
  var out = { scheme: "", host: "", port: "", path: "", query: {}, segments: [] };
  var m = /^([a-z][a-z0-9+.-]*):\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?/i.exec(s);
  if (m) {
    out.scheme = m[1].toLowerCase();
    var auth = m[2].replace(/^[^@]*@/, "");
    var hp = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(auth);
    out.host = (hp ? hp[1] : auth).toLowerCase();
    out.port = hp && hp[2] ? hp[2] : "";
    out.path = m[3] || "";
    (m[4] || "").slice(1).split("&").forEach(function(pair) {
      if (!pair) return;
      var eq = pair.indexOf("=");
      var k = alDecode(eq < 0 ? pair : pair.slice(0, eq), true).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(out.query, k)) {
        out.query[k] = eq < 0 ? "" : alDecode(pair.slice(eq + 1), true);
      }
    });
  } else if (s.charAt(0) === "/") {
    out.scheme = "file";
    out.path = s;
  }
  out.segments = out.path.split("/").filter(function(p) { return p; })
    .map(function(p) { return alDecode(p, false); });
  return out;
}

function alQuery(link, key) {
  return Object.prototype.hasOwnProperty.call(link.query, key) ? String(link.query[key]) : "";
}

// Dots and underscores to spaces; hyphens stay ("WEB-DL", "Spider-Man").
function alSeparators(s) {
  return String(s).replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

// Index of the first quality/edition tag at or after `from`, or -1.
function alFirstCut(s, from) {
  var best = -1, rest = s.slice(from);
  AL_CUT.forEach(function(re) {
    var m = re.exec(rest);
    if (m && (best < 0 || m.index + from < best)) best = m.index + from;
  });
  return best;
}

// A release or file name taken apart. Never throws.
function alParseName(raw) {
  var r = { title: "", year: null, season: null, episode: null, episodes: 1, episodeTitle: "",
            country: null, lead: false, dash: false, dated: false, extra: false, seasonWords: false, tagged: false };
  var s = String(raw == null ? "" : raw).replace(AL_VIDEO_EXT, "");
  s = s.replace(/^\s*(?:\[[^\]]{0,60}\]\s*|【[^】]{0,60}】\s*)+/, "");
  s = s.replace(/^\s*www\.\S+?\s*[-–—:]?\s+/i, "");
  s = s.replace(/^\s*[a-z0-9-]{2,40}\.(?:com|net|org|to|me|cc|tv|io|se|ru|xyz|info|site|club|lol|vip|co|in)\s+[-–—]\s+/i, "");
  s = alSeparators(s);
  if (!s) return r;

  r.dated = /\b(?:19|20)\d{2} (?:0[1-9]|1[0-2]) (?:0[1-9]|[12]\d|3[01])\b/.test(s);

  // Season and episode, most explicit form first.
  var mark = -1, markEnd = -1, m;
  if ((m = /\b[Ss](\d{1,2}) ?[Ee](\d{1,4})((?:[ -]?[Ee]\d{1,4}|-\d{1,4})*)\b/.exec(s))) {
    r.season = +m[1]; r.episode = +m[2];
    var more = (m[3].match(/\d+/g) || []).map(Number);
    var last = more.length ? more[more.length - 1] : r.episode;
    if (last > r.episode && last - r.episode < 10) r.episodes = last - r.episode + 1;
  } else if ((m = /\b(\d{1,2})[xX](\d{2,3})\b/.exec(s))) {
    r.season = +m[1]; r.episode = +m[2];
  } else if ((m = /\bseason ?(\d{1,2})(?: ?[-,] ?| )(?:episode|ep) ?(\d{1,4})\b/i.exec(s))) {
    r.season = +m[1]; r.episode = +m[2];
  }
  if (m) {
    mark = m.index; markEnd = m.index + m[0].length;
  } else {
    var so = /\b(?:[Ss](\d{1,2})|season ?(\d{1,2}))\b/i.exec(s);
    var eo = /\b(?:episode|ep) ?(\d{1,4})\b|\bE(\d{2,4})\b/i.exec(s);
    if (so) { r.season = +(so[1] || so[2]); mark = so.index; markEnd = so.index + so[0].length; }
    if (eo) {
      r.episode = +(eo[1] || eo[2]);
      if (mark < 0 || eo.index < mark) mark = eo.index;
      markEnd = Math.max(markEnd, eo.index + eo[0].length);
    }
  }

  // Year: the last plausible one before the episode or quality tags ("1917" alone is a title)
  var qc = alFirstCut(s, 0);
  r.tagged = qc >= 0;   // carries release tags (1080p, BluRay, x264…)
  var hard = Math.min(mark >= 0 ? mark : s.length, qc >= 0 ? qc : s.length);
  var maxYear = new Date(Date.now()).getFullYear() + 1;
  var yearAt = -1, ym, yre = /\b(19\d{2}|20\d{2})\b/g;
  while (!r.dated && (ym = yre.exec(s))) {
    var y = +ym[1];
    if (ym.index > 0 && ym.index < hard && y <= maxYear && (mark < 0 || ym.index < mark || ym.index >= markEnd)) {
      r.year = y; yearAt = ym.index;
    }
  }

  // Fansub numbering: "Title - 12". Only without a year, which it could be.
  if (r.episode == null && r.year == null) {
    var dm = /(?:^| )[-–] ?(\d{1,4})(?:v\d)?(?= |$|[\[(])/.exec(s);
    if (dm && +dm[1] > 0) {
      r.episode = +dm[1]; r.dash = true;
      if (mark < 0 || dm.index < mark) mark = dm.index;
      markEnd = Math.max(markEnd, dm.index + dm[0].length);
    }
  }
  // "01 - Pilot": the title has to come from the folder
  if (r.episode == null && r.season == null && r.year == null) {
    var lm = /^(\d{1,3})(?:(?: ?[-.] ?| )(?=\S)|$)/.exec(s);
    if (lm) { r.episode = +lm[1]; r.lead = true; mark = 0; markEnd = lm[0].length; }
  }

  var cut = s.length;
  if (mark >= 0) cut = Math.min(cut, mark);
  if (qc >= 0) cut = Math.min(cut, qc);
  if (yearAt >= 0) cut = Math.min(cut, yearAt);
  var title = s.slice(0, cut).replace(/[\[({][^\])}]*$/, "");
  // Only in the show's own name: "Pilot Part 1" is an episode title.
  r.seasonWords = AL_SEASON_WORDS.test(title);
  var c = /\s\(?(US|UK|AU|NZ|CA|IE)\)?\s*$/.exec(title);
  if (c) { r.country = c[1] === "UK" ? "GB" : c[1]; title = title.slice(0, c.index); }
  r.title = title.replace(/[\[({][^\])}]*[\])}]/g, " ").replace(/\s+/g, " ")
    .replace(/^[\s\-–—:,]+|[\s\-–—:,(\[{]+$/g, "");

  var tailAt = markEnd >= 0 ? alFirstCut(s, markEnd) : qc;
  if (markEnd >= 0) {
    r.episodeTitle = s.slice(markEnd, tailAt >= 0 ? tailAt : s.length).replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "");
  }
  // Episode titles may contain any word ("The Opening"); everything else may not.
  var checked = r.episode != null ? r.title + " " + (tailAt >= 0 ? s.slice(tailAt) : "") : s;
  r.extra = AL_EXTRA.test(checked) || /\bsample\b/i.test(s);
  return r;
}

// Is the parsed title something TMDB could be searched for?
function alTitleOk(r) {
  var t = r && r.title ? String(r.title) : "";
  if (!t) return false;
  var letters = (t.match(/\p{L}/gu) || []).length;
  var anchored = r.year != null || (r.season != null && r.episode != null && !r.lead);
  // Numbers ("24", "1917") and two-letter titles ("It") need a year or episode beside them
  if (/^\d{2,4}$/.test(t)) return anchored;
  if (letters < 2 || (letters < 3 && !anchored)) return false;
  if (AL_GENERIC.test(t)) return false;
  var bare = t.replace(/[^0-9a-z]/gi, "");
  if (bare.length >= 12 && /^[0-9a-f]+$/i.test(bare)) return false;      // hashes, UUIDs
  if (/^[A-Za-z0-9_-]{20,}$/.test(t)) return false;                         // keys and tokens
  if (/[=&]/.test(t) || /[0-9a-f]{16,}/i.test(t)) return false;             // query strings, hashes
  if (/^(?=.*\d)[0-9a-f]{6,}$/i.test(t)) return false;                       // short hex ids: "0f9a8b7c"
  if (/^(?=(?:.*\d){3})(?=(?:.*[a-z]){3})[a-z0-9]{10,}$/i.test(t)) return false; // random ids: "aB3kd9Q2x7Lp"
  if (/^(?:part|vol|volume|disc|cd) ?\d+$/i.test(t)) return false;
  return true;
}

// Title from the folder ("Show/Season 1/01.mkv"), but only if the folder looks like a show
function alFolderContext(folders) {
  var n = folders.length;
  if (!n) return null;
  var parent = String(folders[n - 1]).trim();
  var sm = /^(?:season|series|staffel|saison|temporada|stagione) ?(\d{1,2})$|^s(\d{1,2})$/i.exec(parent);
  if (sm) {
    if (n < 2) return null;
    var g = alParseName(folders[n - 2]);
    if (!alTitleOk(g) || AL_FOLDER_DENY.test(g.title)) return null;
    return { title: g.title, year: g.year, country: g.country, season: +(sm[1] || sm[2]), name: folders[n - 2] + "/" + parent };
  }
  var q = alParseName(parent);
  var strong = q.season != null || q.year != null || alFirstCut(alSeparators(parent), 0) >= 0;
  if (!strong || !alTitleOk(q) || AL_FOLDER_DENY.test(q.title)) return null;
  return { title: q.title, year: q.year, country: q.country, season: q.season, name: parent };
}

// One candidate name; weak ones (titles from IINA) need an episode or a year
function alReading(name, folders, source, weak) {
  var p = alParseName(name);
  var from = String(name);
  folders = folders || [];
  if (alTitleOk(p) && p.episode != null && folders.length) {
    // Scene files often start with the group's name
    var ctx = alFolderContext(folders);
    if (ctx && ctx.title && alNorm(p.title) !== alNorm(ctx.title) &&
        alNorm(p.title).slice(-alNorm(ctx.title).length) === alNorm(ctx.title)) {
      p.title = ctx.title;
      from = ctx.name + "/" + name;
    }
  } else if (!alTitleOk(p) && p.episode != null && folders.length) {
    var f = alFolderContext(folders);
    if (f) {
      p.title = f.title; p.year = p.year || f.year; p.country = p.country || f.country;
      if (p.season == null) p.season = f.season;
      p.lead = false;
      from = f.name + "/" + name;
    }
  } else if (!alTitleOk(p) && p.episode == null && folders.length) {
    // A generic or numbered file inside a folder that names it
    var parent = folders[folders.length - 1];
    var q = alParseName(parent);
    var named = q.year != null || (q.season != null && q.episode != null);
    if (named && alUsable({ p: q, weak: false }) && !AL_FOLDER_DENY.test(q.title)) {
      p = q; from = parent + "/" + name;
    }
  }
  if (folders.slice(-2).some(function(f) { return AL_EXTRA_FOLDER.test(String(f).trim()); })) p.extra = true;
  // Web page titles like "… Ending Scene" are clips
  if (weak && AL_EXTRA.test(alSeparators(name))) p.extra = true;
  return { p: p, source: source, weak: !!weak, from: from };
}

function alUsable(rd) {
  var p = rd.p;
  if (!alTitleOk(p) || p.dated || p.lead) return false;
  if (p.season != null && p.episode == null) return false;     // a whole-season pack
  if (rd.weak && p.episode == null && !p.year) return false;
  return true;
}

function alDispositionName(v) {
  var m = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(v) || /filename\s*=\s*"([^"]+)"/i.exec(v) ||
          /filename\s*=\s*([^;]+)/i.exec(v);
  return m ? alDecode(m[1].trim(), false) : "";
}

// Ids a link carries, e.g. Comet's media_id and season/episode
function alIdsFromLink(link) {
  var ids = { imdb: null, season: null, episode: null };
  ["media_id", "imdb", "imdb_id", "imdbid"].forEach(function(k) {
    var v = alQuery(link, k);
    if (!ids.imdb && /^tt\d{6,9}$/.test(v)) ids.imdb = v;
  });
  var i = link.segments.indexOf("playback");
  if (i >= 0) {
    var seg = link.segments.slice(i + 1);
    if (/^[0-9a-f]{40}$/i.test(seg[0] || "") && /^\d+$/.test(seg[3] || "") && /^\d+$/.test(seg[4] || "")) {
      ids.season = +seg[3]; ids.episode = +seg[4];
    }
  }
  return ids;
}

// Stremio's local torrent server: /<info hash>/<file index>
function alStremioPath(link) {
  var m = /^\/([0-9a-fA-F]{40})\/(-?\d+)\/?$/.exec(link.path);
  if (!m || !/^https?$/.test(link.scheme)) return null;
  if (link.host !== "127.0.0.1" && link.host !== "localhost") return null;
  return { origin: link.scheme + "://" + link.host + (link.port ? ":" + link.port : ""), hash: m[1].toLowerCase(), idx: +m[2] };
}

// stats.json names the file; for index -1 take the largest video, like Stremio
async function alStremioName(st) {
  async function stats(path) {
    var r = await withTimeout(iina.http.get(st.origin + path, {}), 4000, "Stremio stats");
    if (r.statusCode !== 200) return null;
    return r.data || JSON.parse(r.text || "null");
  }
  var b = st.idx >= 0 ? await stats("/" + st.hash + "/" + st.idx + "/stats.json") : null;
  if (b && b.streamName) return { file: String(b.streamName), folder: b.name ? String(b.name) : "" };
  var t = await stats("/" + st.hash + "/stats.json");
  if (!t || !t.files || !t.files.length) return null;
  var pick = null;
  t.files.forEach(function(f, i) {
    if (st.idx >= 0 && i !== st.idx) return;
    if (!AL_VIDEO_EXT.test(String(f.name || ""))) return;
    if (!pick || (f.length || 0) > (pick.length || 0)) pick = f;
  });
  return pick ? { file: String(pick.name), folder: t.name ? String(t.name) : "" } : null;
}

// Every name the file is known by, best first.
async function alReadings(h, link) {
  var out = [];
  var st = alStremioPath(link);
  if (st) {
    var sn = null;
    try { sn = await alStremioName(st); } catch (e) { sn = null; }
    if (sn) out.push(alReading(sn.file, sn.folder ? [sn.folder] : [], "Stremio"));
  }
  ["filename", "file", "fn", "name", "title", "torrent_name"].forEach(function(k) {
    var v = alQuery(link, k);
    if (v) out.push(alReading(v, [], "link"));
  });
  ["response-content-disposition", "rscd"].forEach(function(k) {
    var v = alDispositionName(alQuery(link, k));
    if (v) out.push(alReading(v, [], "link"));
  });
  if (link.segments.length && !st) {
    var segs = link.segments, last = segs[segs.length - 1];
    // The end of a link only counts if it looks like a file name
    out.push(alReading(last, segs.slice(0, -1), link.scheme === "file" ? "file name" : "link",
                       link.scheme !== "file" && !AL_VIDEO_EXT.test(last)));
  }
  var lastSeg = link.segments.length ? link.segments[link.segments.length - 1] : "";
  if (h.metadataTitle) {
    out.push(alReading(h.metadataTitle, [], "title in the file", true));
  } else if (h.mediaTitle && h.mediaTitle !== lastSeg && h.mediaTitle !== h.filename) {
    out.push(alReading(h.mediaTitle, [], "title", true));
  }
  return out;
}

// TMDB, cached in @data (errors aren't cached, a 404 is kept for a day)
var AL_CACHE_FILE = "@data/tmdb-cache.json";
var AL_CACHE_MAX = 300;
var alCache = null, alCacheDirty = false;

function alCacheLoad() {
  if (alCache) return;
  try {
    var raw = file.exists(AL_CACHE_FILE) ? file.read(AL_CACHE_FILE) : "";
    alCache = raw ? JSON.parse(raw) : {};
  } catch (e) { alCache = {}; }
  if (!alCache || typeof alCache !== "object" || Array.isArray(alCache)) alCache = {};
}

function alCacheFlush() {
  if (!alCache || !alCacheDirty) return;
  var keys = Object.keys(alCache);
  if (keys.length > AL_CACHE_MAX) {
    keys.sort(function(a, b) { return alCache[a].t - alCache[b].t; });
    keys.slice(0, keys.length - AL_CACHE_MAX).forEach(function(k) { delete alCache[k]; });
  }
  try { file.write(AL_CACHE_FILE, JSON.stringify(alCache)); } catch (e) {}
  alCacheDirty = false;
}

async function alTmdb(path, params, ttlHours, trim) {
  if (!tmdbKey) throw new Error("no TMDB key");
  alCacheLoad();
  var key = path + "?" + Object.keys(params).sort().map(function(k) { return k + "=" + params[k]; }).join("&");
  var now = Date.now(), hit = alCache[key];
  if (hit && now - hit.t < (hit.v === null ? 24 : ttlHours) * 3600000) return hit.v;
  var p = { api_key: tmdbKey };
  Object.keys(params).forEach(function(k) { p[k] = params[k]; });
  var r = await withTimeout(iina.http.get("https://api.themoviedb.org/3" + path, { params: p }), HTTP_TIMEOUT_MS, "TMDB");
  if (r.statusCode === 404) { alCache[key] = { t: now, v: null }; alCacheDirty = true; return null; }
  if (r.statusCode !== 200) throw new Error("TMDB answered " + r.statusCode);
  var v = trim(r.data || JSON.parse(r.text || "{}"));
  alCache[key] = { t: now, v: v };
  alCacheDirty = true;
  return v;
}

async function alSearch(kind, title, extra) {
  var params = { query: title, include_adult: "false" };
  Object.keys(extra || {}).forEach(function(k) { params[k] = String(extra[k]); });
  var v = await alTmdb("/search/" + kind, params, 168, function(d) {
    return (d.results || []).slice(0, 20).map(function(x) {
      return { id: x.id, name: x.name || x.title || "", original: x.original_name || x.original_title || "",
               date: x.first_air_date || x.release_date || "", country: x.origin_country || [],
               votes: x.vote_count || 0 };
    });
  });
  return v || [];
}

function alTvDetails(id) {
  return alTmdb("/tv/" + id, { append_to_response: "alternative_titles,external_ids" }, 24, function(d) {
    return { id: d.id, name: d.name || "", original: d.original_name || "", date: d.first_air_date || "",
             poster: d.poster_path || "", votes: d.vote_count || 0,
             seasons: (d.seasons || []).map(function(s) { return s.season_number; }),
             alt: ((d.alternative_titles && d.alternative_titles.results) || []).map(function(t) { return t.title; }),
             imdb: (d.external_ids && d.external_ids.imdb_id) || "" };
  });
}

function alSeason(id, n) {
  return alTmdb("/tv/" + id + "/season/" + n, {}, 24, function(d) {
    return { poster: d.poster_path || "",
             episodes: (d.episodes || []).map(function(e) {
               return { n: e.episode_number, name: e.name || "", air: e.air_date || "",
                        rating: e.vote_average || 0, overview: e.overview || "", runtime: e.runtime || 0 };
             }) };
  });
}

function alMovieDetails(id) {
  return alTmdb("/movie/" + id, { append_to_response: "alternative_titles,external_ids" }, 168, function(d) {
    return { id: d.id, title: d.title || "", original: d.original_title || "", date: d.release_date || "",
             runtime: d.runtime || 0, rating: d.vote_average || 0, overview: d.overview || "",
             poster: d.poster_path || "", votes: d.vote_count || 0,
             alt: ((d.alternative_titles && d.alternative_titles.titles) || []).map(function(t) { return t.title; }),
             imdb: d.imdb_id || (d.external_ids && d.external_ids.imdb_id) || "" };
  });
}

function alFind(imdb) {
  return alTmdb("/find/" + imdb, { external_source: "imdb_id" }, 168, function(d) {
    return { movie: (d.movie_results || []).map(function(x) { return x.id; }),
             tv: (d.tv_results || []).map(function(x) { return x.id; }),
             episode: (d.tv_episode_results || []).map(function(x) {
               return { show: x.show_id, season: x.season_number, episode: x.episode_number };
             }) };
  });
}

// Deciding
function alNorm(s) {
  return String(s || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`ʼ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

function alTitleMatches(title, names) {
  var a = alNorm(title), a2 = alNorm(String(title).replace(/^\s*(?:the|a|an)\s+/i, ""));
  if (!a) return false;
  return (names || []).some(function(n) {
    var b = alNorm(n);
    return b && (b === a || alNorm(String(n).replace(/^\s*(?:the|a|an)\s+/i, "")) === a2);
  });
}

function alYearOf(date) { var y = parseInt(String(date || "").slice(0, 4), 10); return isNaN(y) ? 0 : y; }

// The file's length should be close to TMDB's runtime
function alLengthFits(seconds, minutes, count) {
  if (!(minutes > 0)) return true;
  var ratio = seconds / (minutes * 60 * (count || 1));
  return ratio >= 0.5 && ratio <= 2;
}

// Search results whose title (or original or alternative title) is the name.
async function alTitleCandidates(kind, list, title) {
  var out = list.slice(0, 10).filter(function(x) { return alTitleMatches(title, [x.name, x.original]); });
  if (out.length) return out;
  for (var i = 0; i < Math.min(3, list.length); i++) {
    var d = kind === "tv" ? await alTvDetails(list[i].id) : await alMovieDetails(list[i].id);
    if (d && alTitleMatches(title, d.alt)) out.push(list[i]);
  }
  return out;
}

// Several fit: only take the first if it towers over the rest.
function alDominant(fits) {
  fits.sort(function(a, b) { return b.votes - a.votes; });
  return fits[0].votes >= 50 && fits[0].votes >= 10 * (fits[1].votes || 0) ? fits[0] : null;
}

function alNotSure(reason, query) { return { info: null, reason: reason, query: query || "" }; }

function alTvInfo(d, sd, ep, season) {
  var info = { isStream: false, showTitle: d.name, epTitle: ep.name || ("Episode " + ep.n),
    code: "S" + alPad2(season) + "E" + alPad2(ep.n), airDate: ep.air,
    rating: ep.rating ? ep.rating.toFixed(1) : "", overview: ep.overview,
    posterUrl: sd.poster ? AL_POSTER + sd.poster : (d.poster ? AL_POSTER + d.poster : ""),
    tmdbId: String(d.id), season: season, episode: ep.n, isMovie: false };
  if (d.imdb) info.parentImdbId = d.imdb;
  return info;
}

function alMovieInfo(d) {
  var info = { showTitle: "Movie", epTitle: d.title, code: d.date ? d.date.slice(0, 4) : "",
    airDate: d.date, isStream: false, rating: d.rating ? d.rating.toFixed(1) : "",
    overview: d.overview, posterUrl: d.poster ? AL_POSTER + d.poster : "",
    tmdbId: String(d.id), season: null, episode: null, isMovie: true };
  if (d.imdb) info.imdbId = d.imdb;
  return info;
}

async function alMatchTv(p, seconds) {
  if (p.seasonWords) return alNotSure("its season numbering may not match TMDB's", p.title);
  if (p.season === 0) return alNotSure("specials are numbered differently everywhere", p.title);
  var list = await alSearch("tv", p.title, p.year ? { first_air_date_year: p.year } : null);
  var loose = false;
  if (p.year && !(await alTitleCandidates("tv", list, p.title)).length) {
    // A year in an episode's name is sometimes when it aired, not when the show began.
    list = await alSearch("tv", p.title, null);
    loose = true;
  }
  var cands = await alTitleCandidates("tv", list, p.title);
  if (p.year) {
    cands = cands.filter(function(c) {
      var y = alYearOf(c.date);
      return y && (loose ? y <= p.year : Math.abs(y - p.year) <= 1);
    });
  }
  if (p.country) cands = cands.filter(function(c) { return c.country.indexOf(p.country) >= 0; });
  if (!cands.length) return alNotSure("TMDB has no show called “" + p.title + "”", p.title);

  // A show we can't check (no season number) still counts against one that fits
  var fits = [], why = "", unresolved = "";
  for (var i = 0; i < Math.min(3, cands.length); i++) {
    var d = await alTvDetails(cands[i].id);
    if (!d) continue;
    var regular = d.seasons.filter(function(n) { return n > 0; });
    var season = p.season;
    if (season == null) {
      if (regular.length !== 1) { why = unresolved = "no season number, and “" + d.name + "” has several"; continue; }
      season = regular[0];
    }
    var sd = await alSeason(d.id, season);
    var ep = sd ? sd.episodes.filter(function(e) { return e.n === p.episode; })[0] : null;
    if (!ep) { why = "“" + d.name + "” has no S" + alPad2(season) + "E" + alPad2(p.episode); continue; }
    if (!alLengthFits(seconds, ep.runtime, p.episodes)) { why = "the video's length doesn't match the episode"; continue; }
    fits.push({ votes: d.votes, info: alTvInfo(d, sd, ep, season) });
  }
  if (fits.length && unresolved) return alNotSure(unresolved, p.title);
  if (fits.length === 1) return { info: fits[0].info, query: p.title };
  if (fits.length > 1) {
    var top = alDominant(fits);
    return top ? { info: top.info, query: p.title } : alNotSure("several shows called “" + p.title + "” fit", p.title);
  }
  return alNotSure(unresolved || why || "no matching episode", p.title);
}

async function alMatchMovie(p, seconds) {
  var list = await alSearch("movie", p.title, p.year ? { primary_release_year: p.year } : null);
  var cands = await alTitleCandidates("movie", list, p.title);
  if (p.year && !cands.length) {
    // Released elsewhere first or a year off: retry without the year
    list = await alSearch("movie", p.title, null);
    cands = await alTitleCandidates("movie", list, p.title);
  }
  if (p.year) cands = cands.filter(function(c) { var y = alYearOf(c.date); return y && Math.abs(y - p.year) <= 1; });
  if (!cands.length) return alNotSure("TMDB has no film called “" + p.title + "”" + (p.year ? " from " + p.year : ""), p.title);

  var fits = [], why = "";
  for (var i = 0; i < Math.min(3, cands.length); i++) {
    var d = await alMovieDetails(cands[i].id);
    if (!d) continue;
    if (!alLengthFits(seconds, d.runtime, 1)) { why = "the video's length doesn't match the film"; continue; }
    // On a plain name an obscure film is more likely a home video
    if (d.votes < 10 && !p.tagged) { why = "“" + d.title + "” is too little-known to match on a plain name"; continue; }
    fits.push({ votes: d.votes, info: alMovieInfo(d) });
  }
  if (fits.length === 1) return { info: fits[0].info, query: p.title };
  if (fits.length > 1) {
    var top = alDominant(fits);
    return top ? { info: top.info, query: p.title } : alNotSure("several films called “" + p.title + "” fit", p.title);
  }
  return alNotSure(why || "no matching film", p.title);
}

// An IMDb id in the link settles it
async function alFromImdb(ids, readings) {
  var f = await alFind(ids.imdb);
  if (!f) return null;
  if (f.episode.length) {
    var x = f.episode[0];
    return alExactTv(x.show, x.season, x.episode);
  }
  if (f.tv.length) {
    var s = ids.season, e = ids.episode;
    if (s == null || e == null) {
      var named = readings.filter(function(rd) { return rd.p.season != null && rd.p.episode != null; })[0];
      if (named) { s = named.p.season; e = named.p.episode; }
    }
    if (s == null || e == null) return alNotSure("the link names the show but not the episode", "");
    return alExactTv(f.tv[0], s, e);
  }
  if (f.movie.length) {
    var d = await alMovieDetails(f.movie[0]);
    return d ? { info: alMovieInfo(d), query: d.title } : null;
  }
  return null;
}

async function alExactTv(showId, season, episode) {
  var d = await alTvDetails(showId);
  var sd = d ? await alSeason(showId, season) : null;
  var ep = sd ? sd.episodes.filter(function(e) { return e.n === episode; })[0] : null;
  if (!ep) return alNotSure("TMDB has no S" + alPad2(season) + "E" + alPad2(episode) + (d ? " of “" + d.name + "”" : ""), d ? d.name : "");
  return { info: alTvInfo(d, sd, ep, season), query: d.name };
}

// seconds() is read late: the length can arrive after the file
async function alLookup(h, seconds) {
  var link = alSplitLink(h.path || h.url || "");
  var readings = await alReadings(h, link);
  var ids = alIdsFromLink(link);
  if (ids.imdb) {
    var exact = await alFromImdb(ids, readings);
    if (exact) return exact;
  }

  var extra = readings.filter(function(rd) { return rd.p.extra; })[0];
  if (extra) return alNotSure("it looks like a trailer, sample or extra", "");
  var usable = readings.filter(alUsable);
  var primary = usable[0];
  if (!primary) {
    var named = readings.filter(function(rd) { return alTitleOk(rd.p); })[0];
    return alNotSure("there is no usable name", named ? named.p.title : "");
  }
  var p = primary.p;
  for (var i = 1; i < usable.length; i++) {
    var o = usable[i].p;
    var sameShape = (o.episode != null) === (p.episode != null);
    if (!sameShape) continue;
    if (alNorm(o.title) !== alNorm(p.title) ||
        (o.episode != null && (o.episode !== p.episode || (o.season != null && p.season != null && o.season !== p.season)))) {
      return alNotSure("its names disagree (“" + p.title + "”, “" + o.title + "”)", p.title);
    }
  }
  var len = seconds();
  if (!(len > 0)) return alNotSure("its length is unknown (a live stream?)", p.title);
  var out = p.episode != null ? await alMatchTv(p, len) : await alMatchMovie(p, len);
  if (out.info) out.from = primary.from;
  return out;
}

function alHints() {
  function str(prop) { try { return String(iina.mpv.getString(prop) || ""); } catch (e) { return ""; } }
  return { path: str("path"), url: currentVideoUrl, filename: str("filename"),
           mediaTitle: str("media-title"), metadataTitle: str("metadata/by-key/title") };
}

function alSeconds() {
  try { return iina.mpv.getNumber("duration") || 0; } catch (e) { return 0; }
}

// Only answer if that file is still playing
async function autoLookup(d) {
  var forUrl = currentVideoUrl;
  if (!d || !d.url || d.url !== forUrl) return;
  var reply = { url: forUrl, info: null, query: "", reason: "" };
  try {
    var out = await alLookup(alHints(), alSeconds);
    reply.info = out.info || null;
    reply.query = out.query || "";
    reply.reason = out.reason || "";
    if (out.info) reply.info.auto = { from: out.from || "" };
  } catch (e) {
    reply.reason = "the lookup failed (" + errStr(e) + ")";
  }
  alCacheFlush();
  if (currentVideoUrl !== forUrl) return;
  log("Automatic Lookup: " + (reply.info
    ? "found " + reply.info.showTitle + (reply.info.isMovie ? "" : " " + reply.info.code)
    : "not sure — " + reply.reason));
  sidebar.postMessage("autoLookupResult", reply);
}

// Sidebar handlers
function registerSidebarHandlers() {

  sidebar.onMessage("episodeSelected", function(info) {
    log("episodeSelected: " + (info ? info.epTitle : "null"));
    currentEpisode = info;
    resolveSegments(info);
  });

  sidebar.onMessage("clearEpisode", function() {
    currentEpisode = null;
    segments = [];
    hideSkip();
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

  // Vertical position slider
  sidebar.onMessage("setOverlayVerticalPos", function(d) {
    var v = parseFloat(d.value);
    if (!isNaN(v)) {
      overlayVerticalPos = Math.max(0, Math.min(100, v));
      if (overlayVisible) overlay.postMessage("setVerticalPos", { value: overlayVerticalPos });
    }
  });

  // Configurable pause delay
  sidebar.onMessage("setPauseDelay", function(d) {
    var v = parseFloat(d.value);
    if (!isNaN(v) && v >= 0.5) pauseDelay = v;
  });

  // Overlay theme: classic | compact | poster
  sidebar.onMessage("setOverlayTheme", function(d) {
    overlayTheme = d && d.value ? String(d.value) : "classic";
    overlay.postMessage("setTheme", { value: overlayTheme });
  });

  // The sidebar's TMDB key, needed for IMDB ids
  sidebar.onMessage("setTmdbKey", function(d) {
    tmdbKey = (d && d.key) ? String(d.key) : "";
  });

  // Automatic Lookup: only asked for when switched on
  sidebar.onMessage("autoLookup", function(d) { autoLookup(d); });

  // "Search again" in the sidebar: ignore the cache and look once more.
  sidebar.onMessage("refreshSkip", function() {
    if (!skipEnabled || !currentEpisode) {
      sidebar.postMessage("skipResult", { count: 0, label: "" });
      return;
    }
    resolveSegments(currentEpisode, true);
  });

  // Skip intro/recap/credits toggle
  sidebar.onMessage("setSkipEnabled", function(d) {
    skipEnabled = !!(d && d.enabled);
    if (!skipEnabled) {
      segments = [];
      hideSkip();
      stopTimeWatcher();
    } else if (currentEpisode) {
      resolveSegments(currentEpisode);
    }
    log("Skip segments " + (skipEnabled ? "enabled" : "disabled"));
  });

  // Sidebar is ready: resend the file in case the first fileChanged came too early
  sidebar.onMessage("sidebarReady", function() {
    if (currentVideoUrl) {
      sidebar.postMessage("fileChanged", { url: currentVideoUrl });
    }
  });

  // Open a URL in the browser; target=_blank doesn't work in IINA's web view
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

  // Resolve IMDB ids early so the opensubtitles.org link is ready
  sidebar.onMessage("resolveImdbOnly", async function(d) {
    if (!d || !d.tmdbId) return;
    try {
      var resolved = await resolveImdbIds(d, d.tmdbKey || "");
      sidebar.postMessage("imdbResolved", {
        imdb:       resolved.imdbId       || null,
        parentImdb: resolved.parentImdbId || null
      });
    } catch(e) {
      // fine if this fails, the link just won't show
    }
  });

  // Wyzie Subs
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
          iina.http.get("https://sub.wyzie.io/search", {
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

      // Wyzie: TMDB id first (fastest), then IMDB id, then the whole show

      if (d.tmdbId && !results) {
        results = await attempt("TMDB lookup", String(d.tmdbId), includeSE);
      }

      if (!results) {
        d = await resolveImdbIds(d, d.tmdbKey || "");
        var imdbForWyzie = withTtPrefix(d.parentImdbId || (d.isMovie ? d.imdbId : null));
        if (imdbForWyzie) {
          results = await attempt("IMDB lookup", imdbForWyzie, includeSE);
        }
      }

      // Whole show, for TV, unless that was already the request
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

  // SubDL (https://subdl.com/api-doc), separate from OpenSubtitles
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

      // Manual query: plain text search
      if (d.manualQuery) {
        progress("Searching SubDL…");
        var mr = await sdCall({ film_name: d.manualQuery, languages: lang, subs_per_page: perPage });
        if (mr.error) sidebar.postMessage("subdlSearchResult", { error: mr.error });
        else          sidebar.postMessage("subdlSearchResult", { results: mr.results });
        return;
      }

      // Auto search: resolve IMDB ids first
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
          // SubDL takes imdb_id with the "tt" prefix
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
        // Fallback: full-season pack
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

  // SubDL serves ZIPs: download to @tmp, unzip, load the subtitle
  sidebar.onMessage("loadSubdlSub", async function(d) {
    if (!d || !d.url) {
      sidebar.postMessage("subdlLoadResult", { success: false, error: "No URL" });
      return;
    }

    // which step failed, for the error message
    var step = "starting";

    try {
      // SubDL gives relative URLs like "/subtitle/123-456.zip"
      var url = d.url;
      if (url.charAt(0) === "/") url = "https://dl.subdl.com" + url;
      else if (!/^https?:\/\//i.test(url)) url = "https://dl.subdl.com/" + url;

      // so downloads don't clash
      var stamp = Date.now() + "-" + Math.floor(Math.random() * 1e6);
      var zipPath    = "@tmp/subdl-" + stamp + ".zip";
      var extractDir = "@tmp/subdl-" + stamp;

      // 1. Download
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

      // 2. Extract dir
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

      // 3. Unzip (macOS's UnZip 6.00 has no -O, so plain flags only)
      step = "unzip";
      var execResult = await utils.exec("/usr/bin/unzip", ["-j", "-o", String(zipAbs), "-d", String(extractAbs)]);
      if (execResult.status !== 0) {
        throw new Error("Unzip failed: " + (execResult.stderr || execResult.stdout || ("exit " + execResult.status)));
      }

      // 4. Find the subtitle, nested zips too
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

      // 5. An empty file means unzip quietly failed
      step = "validate";
      var statResult = await utils.exec("/usr/bin/stat", ["-f", "%z", String(subFile)]);
      var fileSize = parseInt((statResult.stdout || "0").trim(), 10);
      if (!fileSize || fileSize < 10) {
        throw new Error("Extracted subtitle is empty or too small (" + fileSize + " bytes)");
      }

      // 6. Load it; mpv handles the encoding
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
        // Select the new track in case `select` didn't take
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

  // OpenSubtitles
  sidebar.onMessage("osLogin", async function(d) {
    try {
      var resp = await withTimeout(
        iina.http.post("https://api.opensubtitles.com/api/v1/login", {
          headers: {
            "Api-Key":      d.key,
            "Content-Type": "application/json",
            "User-Agent":   OS_USER_AGENT  // required by OS
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
    // One API call: { results, error, status }
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

      // Manual query: plain text search
      if (d.manualQuery) {
        progress("Searching OpenSubtitles…");
        var mq = await osCall({ query: d.manualQuery, languages: lang }, hdrs);
        if (mq.error) sidebar.postMessage("subSearchResult", { error: mq.error });
        else          sidebar.postMessage("subSearchResult", { results: mq.results });
        return;
      }

      // Auto search: resolve IMDB ids, then try in order
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
        // Movies: imdb_id, then tmdb_id + year, then a text query
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
        // Episodes: parent imdb id + season/episode first, as OpenSubtitles recommends, then the fallbacks
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
        "User-Agent":   OS_USER_AGENT  // required by OS
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

var overlayHandlersRegistered = false;
function registerOverlayHandlers() {
  if (overlayHandlersRegistered) return;   // never stack duplicates
  overlayHandlersRegistered = true;
  overlay.onMessage("closeOverlay", function() { hideOverlay(); });
  overlay.onMessage("skipSegment", function() { skipNow("button"); });
}

// A trigger that does not involve the overlay web view at all.
try {
  menu.addItem(menu.item("Skip Intro / Recap / Credits", function() {
    skipNow("menu");
  }, { keyBinding: "Alt+s" }));
} catch(e) {
  iina.console.log("[EpInfo] menu item failed: " + errStr(e));
}

// Events
event.on("iina.window-loaded", function() {
  overlay.loadFile("overlay.html");
  // Handlers registered right after loadFile don't survive the page load
  setTimeout(registerOverlayHandlers, 500);
  setupSidebar();
});

event.on("iina.file-loaded", function() {
  setupSidebar();
  currentEpisode = null;
  segments = [];
  hideSkip();
  stopTimeWatcher();
  hideOverlay();
  // The sidebar looks this URL up in its per-URL memory
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
