# Episode Info — IINA Plugin

Search for episode or movie info from TMDB and display it as an overlay when you pause. Includes subtitle search via Wyzie Subs and OpenSubtitles.com

## Preview

<img width="1427" height="804" alt="image" src="https://github.com/user-attachments/assets/a6e958bb-8e4b-45ce-b171-406d52caa516" />
<img width="1433" height="750" alt="image" src="https://github.com/user-attachments/assets/0c900efe-286c-41ab-9dde-53415d7dca06" />

## Features

- **TMDB-powered episode & movie info** — search any title, see show name, episode title, code, air date, rating, synopsis, and poster
- **Auto-overlay on pause** — info card appears when you pause, vanishes when you resume
- **Customizable overlay** — adjustable shade, vertical position (top / center / bottom), and configurable pause delay
- **Per-URL memory** — once you identify a video, the show/episode is remembered against that file's URL. Re-open it later, even after restarting IINA, and your pick is restored automatically. Each URL keeps its own remembered identification
- **Subtitle search built in** — Wyzie Subs (aggregates OpenSubtitles, SubDL, Podnapisi, and more) and OpenSubtitles.com
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

### Optional — Subtitles

**Wyzie Subs** (free, unlimited, no account needed):

1. Go to [sub.wyzie.io/redeem](https://sub.wyzie.io/redeem) and click Generate
2. Paste the key in the sidebar under Subtitles → Wyzie Subs

**OpenSubtitles.com** (5 downloads/day free, 10/day with login):

1. Register at [opensubtitles.com](https://www.opensubtitles.com) → My Account → API Consumers → Create consumer
2. Paste your API key in the sidebar under Subtitles → OpenSubtitles.com
3. Optionally sign in with your username and password for more downloads

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
- `sub.wyzie.ru` / `sub.wyzie.io` — for subtitle search (Wyzie Subs)
- `api.opensubtitles.com` — for subtitle search/download (OpenSubtitles, optional)

All API keys are stored locally in IINA's sandboxed WebView and never shared. No analytics or tracking of any kind.

## Requirements

- IINA 1.4.0 or later
- macOS 12 or later
- Free TMDB API key ([get one here](https://www.themoviedb.org/settings/api))

## Changelog

See the [Releases page](https://github.com/Zain-Imam/iina-episode-info/releases) for the full version history and detailed release notes.
