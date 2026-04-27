# Episode Info — IINA Plugin

Search for episode or movie info from TMDB and display it as an overlay when you pause. Includes subtitle search across three sources: OpenSubtitles, SubDL, and Wyzie Subs.

## Preview

![Episode Info demo](<img width="800" height="493" alt="Image" src="https://github.com/user-attachments/assets/976d7766-aa42-44e4-a451-21c6657c5f79" />)

## Features

- **TMDB-powered episode & movie info** — search any title, see show name, episode title, code, air date, rating, synopsis, and poster
- **Auto-overlay on pause** — info card appears when you pause, vanishes when you resume
- **Customizable overlay** — adjustable shade, vertical position (top / center / bottom), and configurable pause delay
- **Per-URL memory** — once you identify a video, the show/episode is remembered against that file's URL. Re-open it later, even after restarting IINA, and your pick is restored automatically. Each URL keeps its own remembered identification
- **Three subtitle sources, independent** — OpenSubtitles, SubDL, and Wyzie Subs each with their own search cascade. Combining them dramatically improves coverage, especially for very recent episodes that haven't synced across all databases yet
- **opensubtitles.org website fallback** — one-click button opens the legacy site in your browser when API results are missing for fresh content. Pre-filtered by IMDB ID
- **Per-source manual search** — every subtitle source has its own custom search box, so you can search a different title or release name without losing your selected episode
- **Quick toggles** — show overlay on pause, sidebar dismiss button, one-click clear selection
- **Auto-updates** — install through IINA's plugin manager via GitHub releases and stay current

## Installation

### From GitHub (recommended — gets auto-updates)

1. Open IINA → Preferences → Plugins
2. Click **Install from GitHub...**
3. Enter: `Zain-Imam/iina-episode-info`
4. Click Install

### Manual

Download the latest `.iinaplgz` from [Releases](https://github.com/Zain-Imam/iina-episode-info/releases) and double-click it.

## Setup

### Required — TMDB API Key

1. Get a free key at [The Movie Database](https://www.themoviedb.org) → Settings → API → Developer
2. Open the **Episode Info** tab in IINA's sidebar
3. Paste your key and click Save

### Optional — Subtitle Sources

You can use any combination of the three sources. They search independently, so adding more sources just expands your coverage.

**OpenSubtitles** (5 downloads/day free, 10/day with login):
1. Register at [opensubtitles.com](https://www.opensubtitles.com) → My Account → API Consumers → Create consumer
2. Paste your API key in the sidebar under *Subtitles — OpenSubtitles*
3. Optionally sign in with your username and password for more downloads

**SubDL** (free, no payment):
1. Sign up at [subdl.com](https://subdl.com)
2. Go to [subdl.com/panel/api](https://subdl.com/panel/api) and copy your API key
3. Paste it in the sidebar under *Subtitles — SubDL*

**Wyzie Subs** (free, unlimited, no account needed):
1. Go to [sub.wyzie.io/redeem](https://sub.wyzie.io/redeem) and click Generate
2. Paste the key in the sidebar under *Subtitles — Wyzie Subs*

> **Tip:** OpenSubtitles' modern API sometimes lags days/weeks behind their legacy website for very recent episodes. The plugin shows a *"View on opensubtitles.org →"* button that opens the legacy site in your browser as a manual fallback.

## Usage

1. Open the Episode Info sidebar tab
2. Search for your show or movie and pick the episode
3. Pause the video — the info overlay appears after a short delay
4. Resume — overlay disappears automatically

The next time you open the same file or stream, your identification is restored automatically — no need to search again.

### Customizing the overlay

The sidebar has controls for:
- **Show Overlay on Pause** — toggle the overlay entirely on/off
- **Overlay Shade** — adjust background darkness (0–100%)
- **Overlay Position** — anchor the card to the top, center, or bottom of the video
- **Pause Delay** — change how many seconds to wait after pausing before the overlay appears
- **Clear selection** — forget the saved identification for the current video so you can re-identify it

All of these settings persist across IINA restarts.

## Privacy

This plugin only contacts:
- `api.themoviedb.org` / `image.tmdb.org` — for episode/movie info and posters
- `api.opensubtitles.com` — for subtitle search/download (optional)
- `api.subdl.com` / `dl.subdl.com` — for subtitle search/download (optional)
- `sub.wyzie.ru` / `sub.wyzie.io` — for subtitle search (optional)

All API keys are stored locally in IINA's sandboxed WebView and never shared. No analytics or tracking of any kind.

## Requirements

- IINA 1.4.0 or later
- macOS 12 or later
- Free TMDB API key ([get one here](https://www.themoviedb.org/settings/api))

## Changelog

See the [Releases page](https://github.com/Zain-Imam/iina-episode-info/releases) for the full version history and detailed release notes.
