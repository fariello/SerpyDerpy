# SerpyDerpy (v1.0.6)

A lightweight MS Edge / Google Chrome extension (Manifest V3) that extracts Google Search results into clean, organized Markdown files and comprehensive metadata JSON files. Designed to pair seamlessly with **TidyTexty**.

## New in v1.0.5

- **Renamed to SerpyDerpy**: Evolved from `Goog2MD` to **SerpyDerpy** (`Downloads/SerpyDerpy/`), complete with the custom **Monster Loupe** vector icon (`icon.svg`, `icon16.png`, `icon48.png`, `icon128.png`).

## v1.0.4 Features

- **Parallel Decoy Browsing (3–33s Background Tabs)**:
  - While extracting search results, SerpyDerpy mimics genuine human browsing by occasionally opening a sponsored Google ad or regular organic result in a background tab (`active: false`), scrolling around realistically for a randomized 3 to 33 seconds, and closing it.
  - **Runs in Parallel**: Decoy browsing is completely asynchronous and non-blocking—it never halts, delays, or pauses the main search and extraction pipeline.
  - **Fully Configurable**:
    - Toggle on/off via the popup options.
    - Choose link preference: *Any (sponsored or regular)*, *Prefer sponsored links (fallback regular)*, or *Regular organic links only*.
  - **Audited in Metadata JSON**: All decoy tab visits (URL, type, duration, and timestamp) are automatically recorded in the comprehensive JSON metadata manifest.

## New in v1.0.3

- **Comprehensive Metadata JSON Export (`.json`)**: Alongside the `.md` and `.html` files, SerpyDerpy automatically compiles and downloads a rich, structured `YYYYMMDD-<slug>.json` file.
  - **Audit Timestamps**: Exact start/end timestamps in both UTC ISO and local offset format, plus duration down to milliseconds and per-page extraction timestamps.
  - **Browser & Environment Audit**: Captures public IP address, user-agent string, browser version, platform, OS vendor, system languages, hardware concurrency, device memory, screen dimensions & pixel ratio, viewport size, and local timezone.
  - **File Manifest & Result Associations**: Records all saved Markdown and HTML filenames at the top level, and explicitly associates every individual search result and "People Also Ask" entry with the exact `.md` and `.html` page file in which it appears.

## Features

- **Multi-Page Extraction (1, 2, 3, 5, 7, 11, 13 Pages)**: Extract top 10 up to ~130 search results across multiple pages into a single unified Markdown and JSON file with consecutive ranking.
- **True "Next" Link Click Emulation**: Rather than jumping directly via artificial URL changes, SerpyDerpy locates Google's genuine `"Next"` page element (`#pnnext` / `aria-label="Next page"`), smoothly scrolls it into view, and dispatches realistic mouse events (`mousemove` -> `mousedown` -> `mouseup` -> `click`) to trigger native Google navigation.
- **Gentle Human Simulation (7–27s Delays)**: To stay gentle with Google, multi-page crawling introduces randomized 7–27 second pauses between page requests while running smooth scrolling and mouse movement simulation in the tab.
- **Automatic reCAPTCHA Detection & Resume**: If Google triggers a reCAPTCHA challenge or unusual traffic interstitial, SerpyDerpy brings the search tab to the front, pauses the crawl, prompts you to solve it, and automatically resumes crawling once solved!
- **Start from Existing Search & Continue**:
  - **Save Current Page Only (1-Click)**: Instant extraction of the exact Google search page you are currently viewing.
  - **Save & Crawl Next Pages**: Start from an existing Google search tab and crawl the next N pages automatically by clicking Next.
- **"Try Without Personalization" (`&pws=0`)**: Toggle to append `&pws=0` to Google searches for unbiased, non-personalized search results.
- **Stop Crawl Button**: Abort an ongoing multi-page crawl at any time while keeping and saving all results collected up to that moment.
- **Dynamic Version Badge**: Displays the active version (`v1.0.5`) directly in the popup header so you can verify that the latest extension build is loaded.

## JSON Metadata Structure Example

```json
{
  "version": "1.0.5",
  "generator": {
    "name": "SerpyDerpy",
    "version": "1.0.5",
    "manifestVersion": 3
  },
  "environment": {
    "ipAddress": "198.51.100.42",
    "browser": {
      "userAgent": "Mozilla/5.0 ...",
      "platform": "Win32",
      "language": "en-US",
      "languages": ["en-US", "en"],
      "screen": { "width": 1920, "height": 1080, "devicePixelRatio": 1 },
      "viewport": { "innerWidth": 1400, "innerHeight": 900 },
      "timezone": "America/New_York",
      "timezoneOffsetMinutes": 300
    }
  },
  "searchMetadata": {
    "query": "model coding benchmark results",
    "initialSearchUrl": "https://www.google.com/search?q=...",
    "noPersonalizationApplied": true,
    "pagesRequested": 3,
    "pagesCrawled": 3,
    "totalOrganicResults": 28,
    "totalPeopleAlsoAsk": 6,
    "timestamps": {
      "startedUtc": "2026-11-08T05:25:00.000Z",
      "startedLocal": "2026-11-08T00:25:00-05:00",
      "completedUtc": "2026-11-08T05:25:42.000Z",
      "completedLocal": "2026-11-08T00:25:42-05:00",
      "durationMs": 42000,
      "durationFormatted": "42.0s"
    },
    "pages": [
      {
        "pageNumber": 1,
        "url": "https://www.google.com/search?q=...",
        "resultsOnPage": 10,
        "extractedTimestampUtc": "2026-11-08T05:25:01.000Z",
        "associatedFiles": {
          "markdown": "SerpyDerpy/20261108-...md",
          "html": "SerpyDerpy/20261108-...-p1.html"
        }
      }
    ]
  },
  "savedFiles": {
    "subfolder": "SerpyDerpy",
    "markdown": "SerpyDerpy/20261108-...md",
    "json": "SerpyDerpy/20261108-...json",
    "html": [
      "SerpyDerpy/20261108-...-p1.html",
      "SerpyDerpy/20261108-...-p2.html",
      "SerpyDerpy/20261108-...-p3.html"
    ]
  },
  "decoyBrowsing": {
    "enabled": true,
    "preference": "any",
    "totalDecoyVisits": 2,
    "visits": [
      {
        "url": "https://www.googleadservices.com/pagead/aclk?...",
        "type": "sponsored",
        "title": "Top Coding Benchmarks Comparison",
        "pageNumber": 1,
        "durationMs": 14200,
        "durationFormatted": "14s",
        "timestampUtc": "2026-11-08T05:25:05.100Z"
      }
    ]
  },
  "results": [
    {
      "rank": 1,
      "pageNumber": 1,
      "pageRank": 1,
      "title": "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?",
      "url": "https://www.swebench.com/",
      "domain": "swebench.com",
      "siteName": "SWE-bench",
      "snippet": "...",
      "extractedTimestampUtc": "2026-11-08T05:25:01.000Z",
      "sourceFiles": {
        "markdown": "SerpyDerpy/20261108-...md",
        "html": "SerpyDerpy/20261108-...-p1.html"
      }
    }
  ]
}
```

## Installation / Update (Edge / Chrome)

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable **Developer mode** (toggle in upper right or bottom left).
3. If previously loaded, click the **Reload** (circular arrow) icon on the **SerpyDerpy** card.
   - If loading for the first time, click **Load unpacked** and select:
     `D:\Users\gabri\Antigravity\SerpyDerpy`
4. Click the SerpyDerpy extension icon in your toolbar; verify the header displays **`v1.0.6`**.
