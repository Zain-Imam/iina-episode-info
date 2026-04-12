// ============================================================
// IINA Plugin: Episode Info  v2.3.0
// identifier: com.user.episodeinfo2
// ============================================================

const { core, event, overlay, sidebar } = iina;

var sidebarLoaded  = false;
var currentEpisode = null;
var pauseTimer     = null;

var STYLE = [
  "*{margin:0;padding:0;box-sizing:border-box}",
  "html,body{width:100vw;height:100vh;background:transparent;",
  "overflow:hidden;pointer-events:none;",
  "font-family:'SF Pro Display','Helvetica Neue',Helvetica,Arial,sans-serif}",

  "#wrap{",
  "  position:fixed;top:50%;left:0;right:0;",  // true vertical center
  "  transform:translateY(-50%);",
  "  pointer-events:none;",
  "}",

  // Flex row: text left, poster right
  "#card{",
  "  width:100%;",
  "  background:rgba(10,10,10,0.72);",
  "  padding:28px 5%;",
  "  display:flex;",
  "  align-items:center;",
  "  gap:40px;",
  "}",

  // Text column fills remaining space
  "#text{flex:1;min-width:0}",

  ".sn{font-size:13px;font-weight:600;letter-spacing:.18em;",
  "text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:10px}",

  ".et{font-size:38px;font-weight:700;color:#fff;",
  "line-height:1.15;margin-bottom:12px;",
  "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",

  ".mt{display:flex;align-items:center;gap:0;",
  "font-size:15px;color:rgba(255,255,255,0.55);margin-bottom:14px}",
  ".mt span+span::before{content:' · ';color:rgba(255,255,255,0.3);margin:0 6px}",
  ".rat{color:#f5c518;font-weight:600}",

  ".ov{font-size:14px;color:rgba(255,255,255,0.65);",
  "line-height:1.65;",
  "display:-webkit-box;-webkit-line-clamp:2;",
  "-webkit-box-orient:vertical;overflow:hidden}",

  // Poster column — fixed width, shrinks on narrow screens
  "#poster{",
  "  flex-shrink:0;width:14vw;max-width:200px;min-width:110px;",
  "  align-self:center;",
  "}",
  "#poster img{",
  "  width:100%;border-radius:8px;display:block;",
  "  box-shadow:0 6px 28px rgba(0,0,0,0.7);",
  "  opacity:0.92;",
  "}"
].join("");

function esc(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function log(msg) {
  iina.console.log("[EpInfo] " + msg);
  if (sidebarLoaded) sidebar.postMessage("overlayStatus", { text: msg });
}

function showOverlay(d) {
  var metaParts = [];
  if (d.code)    metaParts.push("<span>" + esc(d.code) + "</span>");
  if (d.airDate) metaParts.push("<span>" + esc(d.airDate) + "</span>");
  if (d.rating)  metaParts.push('<span class="rat">&#9733; ' + esc(d.rating) + "</span>");

  var posterHtml = d.posterUrl
    ? "<div id='poster'><img src='" + d.posterUrl + "' /></div>"
    : "";

  overlay.simpleMode();
  overlay.setStyle(STYLE);
  overlay.setContent(
    "<div id='wrap'><div id='card'>" +
      "<div id='text'>" +
        "<div class='sn'>" + esc(d.showTitle)   + "</div>" +
        "<div class='et'>" + esc(d.epTitle)      + "</div>" +
        "<div class='mt'>" + metaParts.join("")   + "</div>" +
        "<div class='ov'>" + esc(d.overview)      + "</div>" +
      "</div>" +
      posterHtml +
    "</div></div>"
  );
  overlay.show();
  log("✅ Showing: " + d.epTitle);
}

function hideOverlay() {
  if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
  overlay.hide();
}

function registerSidebarHandlers() {
  sidebar.onMessage("episodeSelected", function(info) {
    log("episodeSelected: " + (info ? info.epTitle : "null"));
    currentEpisode = info;
  });
  sidebar.onMessage("clearEpisode", function() {
    currentEpisode = null;
    hideOverlay();
  });
}

function setupSidebar() {
  if (!sidebarLoaded) {
    sidebar.loadFile("sidebar.html");
    sidebarLoaded = true;
    setTimeout(registerSidebarHandlers, 500);
  }
}

event.on("iina.window-loaded", function() { setupSidebar(); });

event.on("iina.file-loaded", function() {
  setupSidebar();
  currentEpisode = null;
  hideOverlay();
  sidebar.postMessage("fileChanged", {});
  sidebar.postMessage("overlayStatus", { text: "Select an episode, then pause" });
});

event.on("mpv.pause.changed", function() {
  if (core.status.paused) {
    if (currentEpisode) {
      pauseTimer = setTimeout(function() {
        pauseTimer = null;
        if (core.status.paused && currentEpisode) showOverlay(currentEpisode);
      }, 3000);
    } else {
      log("Paused — no episode selected");
    }
  } else {
    hideOverlay();
  }
});
