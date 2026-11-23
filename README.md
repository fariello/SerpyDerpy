# SerpyDerpy (v2.0.0)

A Chromium Manifest V3 browser extension (Google Chrome and Microsoft Edge) for crash-resumable multi-engine domain research across Google, Bing, and DuckDuckGo, polite multi-format page archiving, clean Markdown extraction, and structured metadata sidecars.

See `SPEC.md` for the full approved v2.0.0 specification.

## Key Capabilities

- **Campaign Mode (`dashboard.html`):**
  - Loads generic Target Rosters (plain-text domains, CSV, or JSON) and Search Specifications (plain-text templates, CSV, JSON, or a unified `campaign.json`) with per-search page depth (`1-20`, default `3`).
  - Runs **Google**, **Bing**, and **DuckDuckGo** simultaneously in three independent Search Engine Lanes (strictly 1 active tab per engine) with a rolling Target window (`K = 4`), fetch-queue backpressure (`50` pause / `20` resume), bounded configurable-skew delays, and ad-relevance + `1.5%` decoy limits.
  - Decouples Result Link fetching into a polite Fetch Pool (max 1 tab per host) backed by an offscreen streaming worker (`offscreen.js`) for `HEAD` probing, `250 MB` size guards, magic-byte sniffing, `SHA-256` hashing, untouched original source archiving (`.html`, `.pdf`, `.txt`, `.png`, `.docx`, `.raw.md`, `.raw.json`, etc.), and Mozilla `Readability.js` + GFM Markdown extraction.
  - Detects CAPTCHA, Cloudflare Turnstile, and WAF interstitials with corroboration rules; pauses the affected lane or host in **Needs Human Click** so you can click the challenge manually and never saves a challenge page as captured content.
  - Persists all state in IndexedDB (`SerpyDerpyDB`) with `unlimitedStorage` and `{ durability: "strict" }` atomic commits, reconciles interrupted runs on browser startup (`onStartup`), writes incremental JSONL delta checkpoints and streamed full snapshots under `_state/`, and archives `<Target>/_site/` (`robots.txt` and sitemaps) once each Target finishes.
- **Interactive Mode (`popup.html`):**
  - Mode 1 (Active Search Tab on Google, Bing, or DuckDuckGo) and Mode 2 (Direct Search with optional link archiving) sharing the v2 engine adapters, safety guards, and v2 JSON/Markdown formats.

## Output Layout

Campaign files save under `Downloads/<outputRoot>/<Target>/<SearchEngine>/<Search>/`:
- SERP pages: `000-<target>-<engine>-<search>-results.pageNN.[json|md|html]`
- Archived result pages: `NNN-<page title>.[html|htm|pdf|txt|png|raw.md|raw.json|<ext>]`, `NNN-<page title>.md` (HTML and text), and `NNN-<page title>.json` (or `.error.json` on failure/skip)
- Campaign-level artifacts under `Downloads/<outputRoot>/`: `README.md`, `_reports/`, `_state/`, `_exports/`, and `<Target>/_site/`

## Installation (Chrome / Edge)

1. Open `chrome://extensions` or `edge://extensions` and enable **Developer mode**.
2. Click **Load unpacked** (or **Reload**) and select the `SerpyDerpy` folder.
3. In browser download settings, turn **off** *"Ask where to save each file before downloading"*.
4. Click the SerpyDerpy icon to open Interactive Mode or launch the **Campaign Dashboard**.

## Running Automated Unit Tests

Requires Node.js 20+:

```bash
node --test tests/*.test.mjs
```
