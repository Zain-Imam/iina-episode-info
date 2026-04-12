# Episode Info — IINA Plugin

Search for episode or movie info from TMDB and display it as an overlay when you pause. Includes subtitle search via Wyzie Subs and OpenSubtitles.com.

## Preview

<img width="1427" height="804" alt="image" src="https://github.com/user-attachments/assets/a6e958bb-8e4b-45ce-b171-406d52caa516" />
<img width="1433" height="750" alt="image" src="https://github.com/user-attachments/assets/0c900efe-286c-41ab-9dde-53415d7dca06" />


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
1. Get a free key at [themoviedb.org](https://www.themoviedb.org) → Settings → API → Developer
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
3. Pause the video — info overlay appears after 3 seconds
4. Resume — overlay disappears automatically
5. Use the **Show Overlay on Pause** toggle to enable/disable the overlay entirely

## What's New in v1.1.0

- **Subtitle support** — Wyzie Subs (OpenSubtitles + SubDL + Podnapisi + more) and OpenSubtitles.com
- **Overlay toggle** — ON/OFF switch in the sidebar, state persists across restarts
- **Overlay shade slider** — control background darkness (0–100%)
- **Sidebar dismiss button** — hide the overlay while keeping video paused
- **Improved overlay** — better font rendering, larger synopsis text

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
