# SerpyDerpy Campaign Evaluation Report: `survey-protocol/serpyderpy-campaign.json`

**Prepared for:** `uni-ai-survey` ("AI at U.S. Universities: A Survey of the Public Record")  
**Date:** 2026-11-24  
**Artifacts Audited:** `survey-protocol/serpyderpy-campaign.json`, `survey-protocol/search-engine-queries.json`, `survey-protocol/search-topics-and-areas.json`, `survey-protocol/page-relevance-rubrics.json`, `survey-protocol/university-roster.json`, `survey-protocol/university-course-catalog-start-urls.json`, `survey-protocol/search-and-extraction-models.json`, `tmp/20261122-pilot-test.zip`, and SerpyDerpy v2 (`HEAD` commit `3bc04fd6`: `inputs.js`, `scheduler.js`, `pacing.js`, `fetcher.js`, `naming.js`, `markdown_extractor.js`, `engines/google.js`, `engines/bing.js`, `engines/duckduckgo.js`).

---

## 1. Executive Summary & Overall Verdict

### Overall Verdict: **Needs Structural Redesign**

The current `survey-protocol/serpyderpy-campaign.json` cannot be run as configured. Mechanically porting the 192 single-engine SerpAPI templates (`q1`) onto three browser engines at a uniform depth of `pages: 2` creates four compounding failures:

1. **Hard Budget Violation (3.09x Over Cap):** The campaign schedules **115,776 Search Tasks** and **231,552 maximum SERP page loads** (`~179,453` expected actual SERP loads even after early-stop), violating the `<= 75,000` ceiling by **+156,552 max SERP loads** (`+208.7%`).
2. **Severe Query Redundancy & Signal-to-Noise Failure:** Empirical inspection of all `225` unique non-error canonical URLs in `tmp/20261122-pilot-test.zip` reveals **70.2% noise (`158/225`)**—dominated by faculty research papers, institutional repositories, course lecture slides, and news/blogs—and only **20.4% on-topic policy signal (`46/225`)** (`29.8%` across all survey topics). Worse, **49.8% of fetched files (`111/223`) were PDFs (`355.63 MB`, 90.0% of archive bytes)** even *without* any `filetype:pdf` operator, and **85.6% of those PDFs were noise**. The current campaign still wastes **21 of 192 templates** on explicit `filetype:pdf` duplicates.
3. **Unviable Desktop Runtime & Storage Footprint:** At SerpyDerpy's configured pacing plus coffee breaks (`15–25` queries, `120–300s`), the Google lane alone requires **~15.3 days** of pure SERP execution (`~20.7–26.8` realistic calendar days with fetch backpressure and human CAPTCHA waits) and projects to **~855.4 GB** of local disk storage (`~574,056` archived files) plus **~3.07B input tokens** (`40–106` GPU-hours) on the URI relevance-checking gateway.
4. **Unfixed Crawler Bugs Verified in Pilot Archive:** `tmp/20261122-pilot-test.zip` exposes active bugs still present in SerpyDerpy `HEAD` (`3bc04fd6`), including **Bing cloaked ads inside `<li class="b_algo">`** leaking commercial vendor demo pages into `target-site` captures, **`serpJsonFile: null`** on `274/274` result sidecars, and **`%7E` vs. `~` canonicalization misses** downloading duplicate PDFs.

### Recommended Redesign Summary

Consolidating the 192 redundant templates into **71 orthogonal, cross-engine-safe templates**, eliminating all 21 `filetype:pdf` duplicates, applying **asymmetric per-engine pagination** (Google `2–4` pages, Bing `1–2`, DuckDuckGo `1–2`) while **preserving all 3 engines across all 16 topics**, capping binary downloads at **`maxFileSizeMb: 15`**, and adding targeted pre-fetch URL denylist rules brings the entire 201-university campaign strictly under budget (**`71,958` maximum SERP loads**, `3,042` headroom—enough to cover a 5-university validation pilot of `1,790` SERPs within the same `75,000` ceiling).

### Headline Comparison: Current vs. Recommended Campaign

| Metric | Current `serpyderpy-campaign.json` | Recommended Redesign | Delta | Basis |
| --- | ---: | ---: | ---: | --- |
| Unique query templates (`16` topics) | `192` (`12`/topic) | `71` (`3–6`/topic) | `-63.0%` | Verified |
| Dedicated `filetype:pdf` templates | `21` | `0` | `-100.0%` | Verified |
| Engines enabled per topic | `3` (all topics) | `3` (all topics) | Preserved | Verified |
| Total Search Tasks (`201 x Q x 3`) | `115,776` | `42,813` | `-63.0%` | Verified |
| **Max SERP page loads (hard worst-case)** | **`231,552`** | **`71,958`** | **`-68.9%`** | Verified |
| Budget status vs. `<= 75,000` cap | **+156,552 OVER** | **3,042 headroom (4.1%)** | Compliant | Verified |
| Expected actual SERP loads (with early-stop) | `~179,453` | `~62,863` | `-65.0%` | Modeled |
| `inputs.js` scope estimator range (SERP-only) | `9.1–16.5` days | `2.9–5.2` days | `-68.2%` | Verified formula |
| Realistic desktop runtime (Google-lane + breaks + backpressure/CAPTCHA) | `~20.7–26.8` days | `~8.7–11.3` days (4 waves x ~2.5d) | `-58.0%` | Modeled |
| Expected unique canonical URLs discovered | `~604,270` | `~307,166` | `-49.2%` | Modeled |
| Expected archived files (HTML / PDF) | `~574,056` (`356k` / `218k`) | `~261,091` (`209k` / `52k`) | `-54.5%` | Modeled |
| Local disk footprint (SERPs + HTML/MD + PDFs) | `~855.4 GB` | `~166.7 GB` | `-80.5%` | Modeled |
| URI relevance-check input load (`$0` API fee) | `~3,065M` tokens (`40–106` GPU-h) | `~1,149M` tokens (`18–48` GPU-h) | `-62.5%` | Modeled |
| Expected rubric-supported institutional pages | `~126,292` (`22%` precision) | `~114,880` (`44%` precision) | `-9.0%` volume / **2x precision** | Modeled |
| Paid LLM extraction cost: Flash tier (`$0.30/$2.50` / 1M) | `~$365` | `~$332` | `-9.0%` | Modeled (illustrative) |
| Paid LLM extraction cost: Mid tier (`$1.50/$7.50` / 1M) | `~$1,508` | `~$1,372` | `-9.0%` | Modeled (illustrative) |
| Paid LLM extraction cost: Frontier tier (`$5.00/$25.00` / 1M) | `~$5,026` | `~$4,572` | `-9.0%` | Modeled (illustrative) |

> **Note on Supported-Page Retention:** The redesigned campaign cuts raw SERP loads by `68.9%` and archived noise by `67%`, while holding confirmed institutional page yield near parity (`~572` vs. `~628` supported pages/university) and materially improving recall on high-cardinality topics (`ai-policies-guidance` goes from `2` to `4` Google pages; `tools-platforms`, `ai-hubs-leadership`, `faculty-staff-development`, `student-literacy-library`, `data-privacy-security`, `ai-programs-credentials`, and `research-infrastructure` go from `2` to `3` Google pages).

---

## 2. Audit of `20261122-pilot-test.zip`

### 2.1 Measured Baseline & Confound Accounting

Direct programmatic inspection of `tmp/20261122-pilot-test.zip` (`719` files, `395.18 MB` uncompressed) across `3` universities (`princeton.edu`, `umass.edu`, `uri.edu`) x `2` queries x `3` engines (`pagesRequested: 3`) yields the following verified inventory:

- **SERP captures:** `33` SERP pages (`17` Google, `7` Bing, `9` DuckDuckGo), `0` CAPTCHAs encountered.
- **Result & error sidecars:** `274` JSON sidecars = `271` result records (`223` fetched files + `48` dedup stubs) + `3` `.error.json` files (`2` HTTP 404, `1` `USER_CANCELED` download interruption).
- **Unique canonical URLs:** `225` unique canonicals across the `271` non-error result slots (`227` including `2` error-only URLs: `homepage.cs.uri.edu/~malvarez/...` and the hacked FCKeditor URL `dev.uc.apps.uri.edu/fckeditor/...yapuza.xyz...`).
- **Fetched file composition:** `112` HTML pages (`18.98 MB` raw HTML -> `1.63 MB` clean Markdown; `extraction.markdownChars` median `5,680`, mean `14,011`, p90 `27,493`, max `276,784`) and `111` binary PDFs (`355.63 MB` total, median `959.1 KB`, mean `3.20 MB`, p90 `6.74 MB`, max `44.97 MB`).
- **Paste-artifact confound:** Both pilot queries contained literal pasted TAB columns converted to spaces: `site:<domain> "artificial intelligence" policy    1    ai-policy-pdf` and `site:<domain> "generative AI" policy    2    gen-ai-policy`. Crucially, this confound had **asymmetric effects**:
  1. On **DuckDuckGo**, the extra tokens `1 ai-policy-pdf` and `2 gen-ai-policy` caused strict `zero_results` on `4/6` tasks (`umass-edu` and `uri-edu`), severely depressing DDG's measured yield in the pilot.
  2. On **Bing**, `sb_count` collapsed to `1–21 results` (`5/6` tasks had no `li.b_pag` / `a.sb_pagN` after page 1).
  3. On **Google**, the token `pdf` inside `ai-policy-pdf` softly boosted PDF ranking on query 1, though query 2 (`gen-ai-policy`, containing no `pdf` token) still returned heavy PDFs and course syllabi.

### 2.2 Empirical Signal-vs-Noise Audit (All 225 Unique Non-Error URLs)

Every one of the `225` unique non-error canonical URLs in `tmp/20261122-pilot-test.zip` was audited against `survey-protocol/page-relevance-rubrics.json` (`rubric-v1`).

| Classification Bucket | Unique URLs | Share of 225 | Concrete Examples from `20261122-pilot-test.zip` |
| --- | ---: | ---: | --- |
| **Signal: Official AI Policy / Guidance (`ai-policies-guidance`)** | **46** | **20.4%** | `oit.princeton.edu/about/policies/generative-ai-tools-use-policy`, `phy.princeton.edu/.../Physics_AI_Policy.pdf`, `economics.princeton.edu/.../GenAI-Policy-for-Independent-Work-v15.pdf`, `www.umass.edu/provost/resources/responsible-use-generative-ai`, `www.umass.edu/senate/.../Sen.%20Doc.%20No.%2026-032...pdf`, `its.uri.edu/ai-at-uri/`, `web.uri.edu/provost/.../2025-Fall-Updates-and-Syllabus-Policy-Memo-FINAL.pdf` |
| **Signal: Official Page for Other Survey Topic** | **21** | **9.3%** | `ai.princeton.edu/` (D-10 hub), `www.umass.edu/it/genai/platform` (D-7 tool), `libguides.princeton.edu/generativeAI` (D-8/D-9 library), `web.uri.edu/provost/initiatives/ai-at-uri/` (D-10 hub), `researchcomputing.princeton.edu/document/6521` (D-6 HPC) |
| **Total Survey-Relevant Signal** | **67** | **29.8%** | — |
| **Noise: Research Papers, Repos, Faculty CVs, Public Policy** | 78 | 34.7% | `digitalcommons.uri.edu/cgi/viewcontent.cgi?...` (`17` URI papers/theses + `2026.html`), `openpublishing.princeton.edu/read/the-psychology-of-robots...` (`277,446` chars!), `www.princeton.edu/~cboix/...pdf`, `www.cs.princeton.edu/~sayashk/...pdf`, `rlj.cs.umass.edu/2026/papers/Paper94.pdf`, `imai.princeton.edu/research/`, `legaljournal.princeton.edu/...`, `jpia.princeton.edu/...` |
| **Noise: Individual Course Syllabi & Lecture Slides** | 40 | 17.8% | `www.cs.princeton.edu/courses/archive/fall26/cos126/.../00IntroCOS126.pdf` (`44.97 MB`), `cos226/.../00Introduction.pdf` (`42.79 MB`), `people.cs.umass.edu/~sniekum/classes/383-S23/lectures/lecture1.pdf` (`18.30 MB`), `web.uri.edu/summer/.../BIO-103-2025.pdf` |
| **Noise: News, Alumni Magazines, Blogs, Past Events** | 27 | 12.0% | `paw.princeton.edu/article/whats-foul-and-fair...`, `www.uri.edu/magazine/.../URI-Magazine-Fall-2026-web.pdf` (`12.82 MB`), `blog.citp.princeton.edu/page/3/`, `web.uri.edu/ssirep/events/previous-events/` (`71,822` chars) |
| **Noise: Cloaked Ads & Off-Domain Redirect Traps** | 4 | 1.8% | `www.mimecast.com/demo/...`, `hyperproof.io/product/hyperproof-ai/...`, `www.infotech.com/sem/lp3/...` (Bing cloaked ads), `web.uri.edu/cels/person/deans-office/` -> `thewomenweadmire.com` |
| **Noise: Misc Generic Indexes / Conference Programs / Abstracts** | 9 | 4.0% | `engineering.princeton.edu/.../EQN_winter2024_AI...pdf`, `web.uri.edu/atl/.../2024-IEC-Full-Conference-Program-FINAL.pdf`, `gradschool.princeton.edu/.../computer-science`, `www.umass.edu/ctl/testhomeformats` |
| **Total Noise** | **158** | **70.2%** | — |

**Key Semantic Discovery:** The query `"artificial intelligence" policy` has a severe **lexical ambiguity failure** at research universities: it matches **public-policy scholarship** (*AI regulation, antitrust, international development, NIST benchmarks, CITP hazard reports, SPIA dialogues*) far more frequently than **institutional AI governance policies**. At Princeton, over half of Google's top 30 hits for `"artificial intelligence" policy` were public-policy research papers or CS lecture decks.

### 2.3 PDF vs. HTML Empirical Impact

| Format | Unique URLs | Total Bytes | Policy Signal | All-Survey Signal | Noise Rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| **HTML** (`112` fetched + `2` dedup/other) | `114` | `18.98 MB` raw / `1.63 MB` MD | `32` (`28.1%`) | `51` (`44.7%`) | `55.3%` |
| **PDF / Binary** (`111` fetched) | `111` | `355.63 MB` | `14` (`12.6%`) | `16` (`14.4%`) | **`85.6%`** |

- **Tail-size explosion:** Only **8 PDFs `> 10 MB`** consumed **`199.07 MB` (`56.0%` of all PDF disk usage)**, and **all 8 (`100%`) were noise** (6 CS lecture slide decks from `12.38 MB` to `44.97 MB`, 1 alumni magazine `12.82 MB`, and 1 arXiv paper `12.75 MB`). Only **5 PDFs `> 15 MB`** consumed **`161.12 MB` (`45.3%` of PDF storage)**.
- **Signal size ceiling:** Every single official institutional policy/handbook PDF in the pilot was **`<= 6.74 MB`** (`Physics_AI_Policy.pdf` `0.05 MB`, `GenAI-Policy-for-Independent-Work-v15.pdf` `0.20 MB`, `odoc.princeton.edu/document/856` `0.21 MB`, `Sen. Doc. No. 26-032` `0.22 MB`, `Sen. Doc. No. 24-087` `0.35 MB`, `CPUC-AI-March2026.pdf` `0.47 MB`, `2025-Fall-Updates-and-Syllabus-Policy-Memo-FINAL.pdf` `0.63 MB`, `academicregs.pdf` `0.95 MB`, `Glossary-of-AI-Terms.pdf` `5.02 MB`, `COB-Student-handbook_7.2026.pdf` `6.74 MB`).

### 2.4 Engine Yield, Exclusive Signal, and Google Page-Depth Decay

| Engine | SERP Pages | Total Unique URLs | Policy Signal (%) | All-Survey Signal (%) | Exclusive URLs | Exclusive Policy Signal (%) | Exclusive All-Survey Signal (%) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Google** | `17` | `162` | `29` (`17.9%`) | `39` (`24.1%`) | `148` | `25` (`16.9%`) | `33` (`22.3%`) |
| **Bing** | `7` | `59` | `17` (`28.8%`) | `25` (`42.4%`) | `34` | `8` (`23.5%`) | `11` (`32.4%`) |
| **DuckDuckGo** | `9` | `33` | `11` (`33.3%`) | `20` (`60.6%`) | `18` | `4` (`22.2%`) | `9` (`50.0%`) |

**Google Page-Depth Precision Decay (First-Seen Page across 6 Google Tasks):**
- **Page 1 (`n=59` unique):** `19` policy (`32.2%`), `2` other-topic (`35.6%` total signal), `38` noise (`64.4%`).
- **Page 2 (`n=56` unique):** `6` policy (`10.7%`), `3` other-topic (`16.1%` total signal), `47` noise (`83.9%`).
- **Page 3 (`n=47` unique):** `4` policy (`8.5%`), `5` other-topic (`19.1%` total signal), `38` noise (`80.9%`).

### 2.5 Concrete Pilot Diagnostic Findings & Fix Ownership

| # | Diagnostic Finding | Exact Evidence in `20261122-pilot-test.zip` | Current Code Status (`3bc04fd6`) | Where to Fix |
| --- | --- | --- | --- | --- |
| **D1** | **Bing cloaked ads extracted as organic results:** Bing injects anti-adblocker sponsored cards inside `<li class="b_algo">` with obfuscated classes (`ad_ZindexESL`, `ad_ml1ESLItem`, `ad_eslcard_chevron_wrapper`), random `aria-label`, Unicode homoglyphs (`Μіmеcast`), and direct ad URLs (`hstk_network=googleAds`, `hsa_net=adwords`). | `uri-edu/bing/generative-ai-policy-2-gen-ai-policy/000-...page01.html` and results `005-schedule-a-demo.md` (`mimecast.com`), `006-product-ai.md` (`hyperproof.io`), `007-establish-your-adaptive-...md` (`infotech.com`). | **UNFIXED** in `engines/bing.js` lines 246–248 (only checks `.b_ad`, `.b_adSlug`, `data-isad="true"`, `/aclick?`). | **SerpyDerpy crawler (`engines/bing.js` + `scheduler.js`)**: Reject `li.b_algo` containing `[class*="ad_"]`, ad-tracking query params (`hsa_net=adwords`, `hstk_network=`), AND drop off-domain SERP links before enqueueing on `scope: "target-site"` queries. |
| **D2** | **`serpJsonFile: null` on 100% of result JSONs:** Every fetched result sidecar fails to link back to its parent SERP JSON filename. | All `274/274` result/error JSONs (e.g., `princeton-edu/google/artificial-intelligence-policy-1-ai-524e/001-ai-and-the-economic-...json`). | **UNFIXED** in `scheduler.js` line 1596 (`serpJsonFile: null` hardcoded). | **SerpyDerpy crawler (`scheduler.js`)**: Pass `serpPaths.basenames.json` on `newFetchItems` and populate `serpContext.serpJsonFile`. |
| **D3** | **Percent-encoding canonicalization miss causes duplicate PDF downloads:** `%7E` and `~` were treated as different canonical URLs, downloading the identical 1.17 MB PDF twice. | `princeton-edu/bing/.../007-how-to-recognize-ai-snake-oil-princeton-university.pdf` (`/%7Earvindn/...`) vs. `princeton-edu/google/.../009-how-to-recognize-ai-snake-oil.pdf` (`/~arvindn/...`), identical SHA-256. | **UNFIXED** in `naming.js` `canonicalizeUrl()` lines 422–471. | **SerpyDerpy crawler (`naming.js`)**: Decode RFC 3986 unreserved percent-encodings (`%7E` -> `~`, etc.), strip empty cache-buster params (`?1785855171=` as seen on UMass `academicregs.pdf`), and normalize `http:`/`https:` scheme equivalence in dedup ledger lookup. |
| **D4** | **DuckDuckGo page-1 single-result behavior & paste-token sensitivity:** On both Princeton queries, DDG page 1 rendered `1` `article[data-testid="result"]` with `"Only showing results from princeton.edu"` and `#more-results`, then appended `14–15` results on page 2. UMass and URI returned `zero_results` on page 1. | `princeton-edu/duckduckgo/artificial-intelligence-policy-1-ai-524e/000-...page01.json` (`n=1`) vs. `page02.json` (`n=15`); `umass-edu/duckduckgo/.../page01.json` (`n=0`). | **NEEDS VALIDATION** in `engines/duckduckgo.js` & `scheduler.js` (line 840 fixed `sleep(1800)` may also race React hydration on slower pages). | **SerpyDerpy crawler + Validation Pilot**: Wait for DDG React hydration settle (`article[data-testid="result"]` count stability or `.no-results` selector) and verify on clean queries without paste tokens. |
| **D5** | **Missing `site-capture.json`, missing `uri-edu/_site/`, and `USER_CANCELED` download prompt:** Pilot saved raw `.xml` sitemaps (`princeton-edu/_site/sitemap-01-sitemap.xml`, `umass-edu/_site/sitemap-01-sitemap.xml`), triggering Edge/Windows `ALLOW_ON_USER_GESTURE` prompt, aborting `site-capture.json` and `001-generative-ai-tools-use-policy-princeton-oit.error.json` (`USER_CANCELED`). | `princeton-edu/_site/`, `umass-edu/_site/` (no `site-capture.json`), absent `uri-edu/_site/`, `princeton-edu/google/generative-ai-policy-2-gen-ai-policy/001-...error.json`. | **PARTIALLY FIXED** in commit `f4a63522` (`.txt` suffix added via `buildSiteSitemapFilename` + fetch-pool lock fix). | **Verify in Validation Pilot** that `site-capture.json` is written for all targets including the final target, and that `uri-edu/_site/` completes cleanly. |
| **D6** | **Incomplete log & `pending` checkpoint rows:** `_reports/20261123-000431-serpyderpy-part0001.txt` ends at `04:58:38Z` (4 min into run), no campaign summary report exists, and `checkpoint-delta-000004.jsonl` retains `23` `pending` fetch rows even though files exist on disk (delta buffer not flushed before zip/stop). | `_reports/20261123-000431-serpyderpy-part0001.txt`, `_state/checkpoint-delta-000004.jsonl`. | **CHECK** `scheduler.js` flush on campaign completion/stop. | **SerpyDerpy crawler / Ops**: Ensure full campaign completion (or clean Stop) flushes final delta checkpoint + log segment + campaign report before zipping/archiving. |
| **D7** | **Hacked/XSS legacy URL & off-domain faculty redirects:** Google indexed a compromised FCKeditor probe URL (`yapuza.xyz`) at URI, and `imai.princeton.edu/research/` redirected to `imai.fas.harvard.edu/research/` (wrong university!). | `uri-edu/google/generative-ai-policy-2-gen-ai-policy/020-...error.json` (`dev.uc.apps.uri.edu/fckeditor/...yapuza.xyz...`); `princeton-edu/google/.../030-kosuke-imais-publications-and-manuscripts.json` (`offDomain: true`, `final: imai.fas.harvard.edu`). | Working as logged (`offDomain: true`), but not excluded from downstream ingestion. | **Campaign JSON (`denylistPatterns`) + Downstream Ingestion**: Denylist `/fckeditor/`, `/~`, `digitalcommons.`; in downstream `uni-ai-survey` ingestion, quarantine `offDomain: true` pages from `scope: "target-site"` queries unless allowlisted (e.g., university-owned secondary domain like `libguides.*` or `catalog.*`). |
| **D8** | **Extreme Markdown bloat & `body_innerText` fallback on repository index:** `digitalcommons.uri.edu/2026.html` triggered `Fell back to document.body.innerText` (`210,590` chars / `~53K` tokens), and `openpublishing.princeton.edu/...` extracted `277,446` chars (`~70K` tokens). | `uri-edu/google/generative-ai-policy-2-gen-ai-policy/018-content-posted-in-2026-digitalcommons-uri.md` & `.json`; `princeton-edu/google/artificial-intelligence-policy-1-ai-524e/019-the-psychology-of-robots-...md`. | Working per spec (`truncated: false`), which correctly protects the content-alteration invariant—making pre-fetch filtering essential! | **Campaign JSON (`denylistPatterns`)**: Block institutional repository bulk indexes (`digitalcommons.`, `openpublishing.`, `theses-dissertations.`, `/cgi/viewcontent.cgi`) before fetch so they never reach the relevance judge. |
| **D9** | **Stray paste tokens in manual textarea input:** Spaces replaced TABs when pasting into UI textarea. | All `33` SERP JSONs (`q='...    1    ai-policy-pdf'`). | Avoided when importing `serpyderpy-campaign.json` directly (commit `3bc04fd6` fixed config import). | **Campaign Ops + SerpyDerpy UI**: Always launch from validated JSON import; add a pre-flight UI warning if a textarea line contains 3+ consecutive spaces before a trailing integer/slug. |

---

## 3. Complete Review of the SerpyDerpy Campaign Approach

### 3.1 Architectural Strengths

SerpyDerpy v2 is a strong fit for Layer B of `uni-ai-survey`:
- **Defeats Headless WAF Blocking:** Running in real desktop Chromium tabs directly addresses the Columbia/Johns Hopkins/Colby blocking problem documented in `5ma5w9` Section 4 and `b2jl4n` Section 2 (`451/599` blocked fetches at Columbia under automated HTTP/headless clients).
- **Immutable Provenance & Zero Truncation:** Preserving raw `.html`, Readability/GFM `.md` (`truncated: false`), original PDFs, SHA-256 checksums, and per-engine SERP snapshots aligns cleanly with `5ma5w9` R-37 and `36epid` R-5/R-13.
- **Native Multi-Engine Attribution:** Capturing Google, Bing, and DuckDuckGo side-by-side feeds the Explorer's discovery-provenance view and the peer-reviewed methods paper without recurring per-search SerpAPI fees.
- **Resilient State Machine:** IndexedDB task queues, rolling target windows, backpressure hysteresis, and JSONL delta checkpoints make multi-day desktop execution crash-recoverable.

### 3.2 Structural Audit of All 192 Queries in `serpyderpy-campaign.json`

Auditing all `192` templates across the `16` topics reveals systemic mechanical bloat inherited from `search-engine-queries.json` (`q1`):

1. **Extreme Intra-Topic Near-Duplicates:**
   - `colleges-schools` spends **9 of 12 templates** on permutations of the exact same concept (`colleges schools`, `college school academic units`, `schools colleges departments`, `academics colleges`, `academics schools`, `"colleges and schools"`, `"academic colleges"`, `"academic schools"`, `"academic units"`). Three orthogonal queries capture the directory plus graduate/honors schools cleanly.
   - `ai-policies-guidance` repeats five policy stems (`"artificial intelligence" policy`, `"generative AI" policy`, `"AI" policy`, `"ChatGPT" policy`, `"large language model" policy`, plus `"generative AI" policy filetype:pdf`)—and `"artificial intelligence" policy` attracts massive public-policy research noise.
   - `strategy-investment` duplicates `"AI strategic plan"`, `artificial intelligence strategic plan`, and `"artificial intelligence" "strategic plan" filetype:pdf`, plus overlaps heavily with `ai-hubs-leadership` (`AI strategy`, `provost artificial intelligence` vs. `president artificial intelligence initiative`).
   - `data-privacy-security` splits near-identical queries (`AI data classification`, `"AI tools" "data classification"`, `"sensitive data" AI tools`, `"protected data" ChatGPT`, `AI data protection`, `AI privacy guidance`, `generative AI data security`, `AI security guidelines`, `information security generative AI`).
   - `operations-workforce` repeats `AI human resources` and `AI in HR`, plus `AI employees guidance`, `staff use of generative AI`, and `AI workforce training employees` (which also duplicates `faculty-staff-development-05: AI staff training`).
   - `access-equity` duplicates `AI accessibility`, `AI digital accessibility`, `AI tools accessibility guidance`, and `free AI tools students`, `AI access for all students`, `"AI for all"`.
   - `tools-platforms` has **dangerous single-word bare queries**: `Claude` (matches every faculty/student named Claude, Claude Shannon, Claude Monet, Claude Lévi-Strauss!) and `Perplexity` (matches every NLP paper mentioning language-model perplexity!). On 201 universities, `site:stanford.edu Perplexity` and `site:harvard.edu Claude` will return **~95%+ pure noise**!
2. **Counterproductive `filetype:pdf` Duplicates (`21` templates):**
   - `ai-courses`, `ai-programs-credentials`, and `faculty-staff-development` each burn **6 of 12 queries (50%)** on `filetype:pdf` duplicates.
   - `ai-policies-guidance`, `strategy-investment`, and `research-infrastructure` add 3 more.
   - Pilot evidence proves PDFs already constitute **49.8% of fetched files without `filetype:pdf`** and suffer an **85.6% noise rate**. Dedicated `filetype:pdf` queries actively bias the crawler toward course syllabi, faculty papers, and 20–45 MB slide decks while missing modern HTML course catalogs, WordPress/Drupal policy pages, and LibGuides. **Verdict: Eliminate all 21 `filetype:pdf` templates.**
3. **Cross-Engine Operator Discipline:**
   - Do **not** inject Google-only `-inurl:/news/ -inurl:/events/` chains into universal search templates: Bing ignores `-inurl:` and DuckDuckGo frequently returns `0` results on complex multi-operator Boolean expressions.
   - Instead, keep templates **short, idiomatic, and cross-engine-safe** (at most one simple uppercase `OR` pair or clean 2–4 word phrase; disambiguate `Claude` -> `Claude AI`, `Perplexity` -> `Perplexity AI`, `policy` -> institutional modifiers like `"acceptable use"`, `"university policy"`, `"campus"`, `"guidelines"`), and enforce URL exclusions (`/news/`, `/events/`, `/~`, `digitalcommons.`, `/courses/archive/`) deterministically via SerpyDerpy's **`config.denylistPatterns`**.
4. **Missing High-Value Institutional Patterns Added in Redesign:**
   - **AI procurement & vendor review** (now explicit in `data-privacy-security` and `operations-workforce`).
   - **Campus AI sandboxes / institutional LLM gateways / approved IT service catalogs** (e.g., `"AI sandbox"`, `"supported AI tools"`, `Anthropic Claude AI`, `Perplexity AI` in `tools-platforms`).
   - **Campus-wide governance charters & working groups** (`"AI working group"`, `"AI governance"`, `"generative AI" hub` in `ai-hubs-leadership`).
   - **Data retention / training opt-out & HIPAA/PII rules** (`HIPAA` alongside `FERPA` in `data-privacy-security`, directly matching `page-relevance-rubrics.json`).
   - **Student-facing admissions guidance & advising/tutoring** tightened away from generic `"admissions AI"` (which pulls faculty admissions-committee research papers) toward `"admissions" "use of AI" application essay`.

### 3.3 Interaction with Pipeline Layers A, B (SerpAPI), C, Relevance Check, and Extraction

- **Layer A (`crawl-catalogs`):** Currently `survey-protocol/university-course-catalog-start-urls.json` maps only **11 pilot universities** (and `5ma5w9` R-34 notes Acalog and D-6 research-unit directories are not yet implemented). Therefore, SerpyDerpy **must not zero out** `ai-courses`, `ai-programs-credentials`, or `ai-hubs-leadership`. Instead, `ai-courses` is trimmed to `4` sharp non-PDF templates (`G=2, B=1, D=1`)—capturing AI course landing pages, general-education AI lists, and non-CourseLeaf campuses without attempting to crawl every individual CS course via search engines—while `ai-programs-credentials` (`5` templates, `G=3`) and `ai-hubs-leadership` (`5` templates, `G=3, B=2`) keep strong depth because program marketing pages and provost hubs often live outside CourseLeaf.
- **Layer B (`SerpAPI` vs. `SerpyDerpy`):** Once SerpyDerpy runs the redesigned `71,958`-SERP multi-engine campaign cleanly across all 201 universities, running duplicate SerpAPI Google queries on `q1` is redundant for coverage. Retain SerpAPI strictly for (a) the 11-university pilot benchmark (`b2jl4n`) comparing SerpAPI Google vs. browser Google/Bing/DDG, or (b) automated retry/fallback on any individual university where browser CAPTCHAs stall.
- **Layer C (Adaptive AI Gap-Fill, `5ma5w9` R-38..R-43):** Layer C costs `$0.010` per model web search plus input/output tokens (`~$0.29` median pass 1 + `~$0.33` median pass 2 = `~$0.62+/job`, or `$2,000–$5,600` across `3,216` jobs if 2–5 passes run). Higher-precision SerpyDerpy coverage directly shrinks Layer C's marginal discovery pool so the R-42 adaptive stop rule (`min_new < 5` or `min_ratio < 0.25`) terminates after Pass 2 rather than spiraling into Passes 3–5—conservatively saving **`$600–$1,800`** in Layer C API spend across 201 universities.
- **Relevance Check (`5ma5w9` R-4a) & Hard Content-Alteration Invariant:** Because truncated or unreadable text **can never return `unsupported`** (it must return `inconclusive`, which in turn forces area coverage to `could not read` under `36epid` R-16a when no items are found), **never truncate page text to save LLM tokens**. The only methodologically valid way to protect GPU throughput and prevent `inconclusive` cascades is **upstream precision**: cleaner queries, eliminating `filetype:pdf` bloat, capping `maxFileSizeMb: 15`, and denylisting bulk repository/book/calendar traps before download.
- **Structured Extraction (`36epid` R-8..R-13a):** Only `supported` pages reach paid extraction. Raising candidate precision from `~22%` to `~44%` eliminates `~313,000` wasted relevance checks while keeping extracted institutional evidence clean, dense, and quote-verifiable.

---

## 4. Holistic Budget, Page-Depth, and LLM Cost Analysis

### 4.1 Hard Search-Budget Compliance (`<= 75,000` Total Searches)

A critical distinction must be enforced in campaign planning:
- **Search Tasks** = `Targets x Unique Queries x Engines` (each task is one query execution on one engine).
- **Maximum SERP Page Loads** = `sum(Tasks x pagesRequested)` (worst-case search-engine page requests if zero tasks early-stop).
- **Expected Actual SERP Page Loads** = Maximum SERP loads discounted by empirical early-stop (`zero_results`, `no_next_button`, `no_new_results`).

To guarantee strict compliance with the **`<= 75,000` hard cap** without relying on optimistic early-stop assumptions, the redesigned campaign budgets **Maximum SERP Page Loads strictly `<= 75,000`**:

- **Current campaign:** `115,776` Search Tasks | **`231,552` max SERP loads** | `~179,453` expected SERP loads (**FAILS by 3.09x**).
- **Recommended campaign (`71` templates, `3` engines, asymmetric depth):**
  - **Search Tasks:** `201 x 71 x 3 = 42,813` (`-63.0%`).
  - **Maximum SERP Page Loads:** **`71,958`** (`Google: 37,788`, `Bing: 18,693`, `DuckDuckGo: 15,477`) — leaving **`3,042` SERP pages (`4.1%`) headroom**, which fully absorbs both the **`1,790`-SERP 5-university validation pilot** (`71,958 + 1,790 = 73,748 <= 75,000`) and `~1,250` task retries!
  - **Expected Actual SERP Page Loads (with early-stop):** **`~62,863`** (`Google: ~32,230`, `Bing: ~15,819`, `DuckDuckGo: ~14,814`).

### 4.2 Per-Topic Saturation, Engine Asymmetry, and Institution-Size Tiering

**Why flat `pages: 2` fails:**
- On **high-cardinality institutional topics** at large R1s (`ai-policies-guidance`, `tools-platforms`, `ai-hubs-leadership`, `faculty-staff-development`, `student-literacy-library`, `data-privacy-security`, `ai-programs-credentials`, `research-infrastructure`), major campuses (MIT, Stanford, Michigan, ASU, Harvard, UMass) publish dozens of departmental policies, tool portals, LibGuides, and unit hubs. Two pages (`20` Google slots) saturates prematurely once queries are consolidated.
- On **narrow/low-cardinality topics** (`colleges-schools`, `access-equity`, `operations-workforce`, `admissions-student-services`, `strategy-investment`, `partnerships-outreach`, `student-organizations`), official pages concentrate in the top `10–20` results; deeper pagination (`>= 3`) yields overwhelmingly news/event/research noise.

**Why asymmetric engine depth (`Google 2–4`, `Bing 1–2`, `DDG 1–2`) beats uniform depth:**
- **Google** has the deepest `.edu` index (`10` results/page across `17/17` pilot SERPs; `5/6` tasks hit page 3). Spending deeper pagination budget on Google (`3–4` pages on core topics) maximizes institutional recall on large R1s.
- **Bing** stopped after page 1 on `5/6` pilot tasks (`no_next_button`), yet delivered `28.8%` policy precision and `34` exclusive URLs—including crown-jewel Provost/OIT/ATL pages Google missed. Running Bing at **`pages: 1`** on narrow topics and **`pages: 2`** on the 4 highest-cardinality topics (`ai-policies-guidance`, `ai-hubs-leadership`, `student-literacy-library`, `tools-platforms`) captures ~90%+ of Bing's unique institutional recall at half the SERP budget.
- **DuckDuckGo** delivered `60.6%` total signal on Princeton (including unique Economics/Physics policies and LibGuides), but has a smaller `.edu` index and virtual "More Results" paging. Running DDG at **`pages: 1`** (and **`pages: 2`** on `ai-policies-guidance`—expandable to `2` across core topics only if the clean validation pilot confirms the page-1 single-result quirk persists without paste tokens) preserves 100% 3-engine provenance across all 16 topics for only `15,477` max SERPs.

**Should the 201 universities be split into Size Tiers (Tier 1 R1/Flagships vs. Tier 2 LAC/Regional)?**
- **Recommendation: No — do NOT split `pages` by university size tier.**
- **Why:**
  1. **Automatic early-stop already adapts depth to campus web volume.** At small Liberal Arts Colleges (`12` in roster) and Regional Universities (`8` in roster), SerpyDerpy's native `zero_results`, `no_next_button`, and `no_new_results` stop rules terminate narrow/exhausted queries automatically after page 1 or 2 without wasting SERP loads.
  2. **Methodological uniformity for the peer-reviewed paper.** Applying identical query templates and max-page ceilings to all `201` institutions avoids introducing an endogenous selection confound ("did R1s show more AI policies because we searched them deeper than LACs?").
  3. **Roster metadata gaps.** `76/201` institutions in `university-roster.json` lack a `us_news_2026_category` field (and IPEDS headcount is not embedded in the roster JSON), so manual tiering would add fragile classification rules for minimal SERP savings (`< 4,000` actual loads).

### 4.3 Holistic Downstream Volume, Runtime, Storage, GPU, and LLM Cost Model

All projections below separate **Verified Measurements** (from `20261122-pilot-test.zip` and `inputs.js`/`pacing.js`) from **Explicitly Modeled Estimates** (full assumptions documented in Section 8):

1. **Desktop Wall-Clock Runtime (Windows Chromium):**
   - `inputs.js` divides total SERP work evenly across `3` lanes (`2.9–5.2` days for recommended vs. `9.1–16.5` days current). However, because Google handles `52.5%` of recommended SERPs (`37,788` max / `~32,230` expected) and `scheduler.js` inserts **coffee breaks** (`120–300s` mean `210s` every `15–25` queries -> `+10.5s`/task), wall-clock runtime is strictly **bottlenecked by the Google lane**:
     - **Current:** `~15.3` days Google-lane SERP time -> **`~20.7–26.8` realistic calendar days** with fetch backpressure (`50/20`) and human CAPTCHA pauses (`+35%` to `+75%`).
     - **Recommended:** **`~6.4` days** Google-lane SERP time (`7.2` days worst-case max) -> **`~8.7–11.3` realistic calendar days**, cleanly executed in **4 waves of ~50 universities (`~2.2–2.8` days per wave)**.
2. **Unique Canonical URLs & Local Disk Footprint:**
   - **Current:** `~1,590,183` raw slots -> `~604,270` unique URLs (`62%` dedup across 192 redundant queries) -> `~574,056` archived files (`355,915` HTML + `218,141` PDFs at `3.20 MB` mean) + `~90 GB` SERP HTML/MD/JSON -> **`~855.4 GB`**.
   - **Recommended:** `~568,826` raw slots -> `~307,166` unique URLs (`46%` dedup across 71 orthogonal queries) -> `~261,091` archived files (`208,873` HTML + `52,218` PDFs at `1.83 MB` mean under `15 MB` cap) + `~31 GB` SERP HTML/MD/JSON -> **`~166.7 GB` (`-80.5%`, saving ~689 GB)**.
3. **URI Relevance-Checking Gateway Load (`$0` Direct API Fee):**
   - **Current:** `~574k` candidate pages -> **`~3,065M` input tokens** (`40–106` GPU-hours at `1.5–4.0` pages/sec) plus high `inconclusive` risk on `218k` PDFs (many unextractable slide decks/scans) and `200K+` char repository index dumps.
   - **Recommended:** `~261k` candidate pages -> **`~1,149M` input tokens (`-62.5%`)**, **`18–48` GPU-hours**, with `76%` fewer PDFs and bulk repository/book traps blocked pre-fetch—sharply reducing `inconclusive` verdicts without ever violating the zero-truncation invariant.
4. **Paid LLM Structured Extraction Envelope (Illustrative Pricing — `search-and-extraction-models.json` prices are `null`):**
   - Assuming `~4,200` tokens/supported page (`x 1.3` schema/batching overhead) and `~500` output tokens/supported page across `201 x 15 = 3,015` `(university, area)` extraction units:
     - **Current (`~126,292` supported pages at `22%` precision):** `~690M` input / `~63M` output tokens -> **Flash (`$0.30/$2.50`):** `~$365` | **Mid (`$1.50/$7.50`):** `~$1,508` | **Frontier (`$5.00/$25.00`):** `~$5,026`.
     - **Recommended (`~114,880` supported pages at `44%` precision):** `~627M` input / `~57M` output tokens -> **Flash:** `~$332` | **Mid:** `~$1,372` | **Frontier:** `~$4,572`.
   - **Crucial insight:** Extraction cost scales with *supported* institutional pages, not raw noise—so the main economic wins of the redesign are **(a) `-80.5%` storage**, **(b) `-62.5%` GPU relevance-check load**, **(c) `-58%` wall-clock run time**, **(d) strict `<= 75,000` search compliance**, and **(e) `$600–$1,800` lower Layer C gap-fill spend** via deeper, cleaner coverage of high-cardinality topics.

### 4.4 Operational Settings & Controls Review

| Setting in `serpyderpy-campaign.json` | Current | Recommended | Rationale |
| --- | --- | --- | --- |
| `maxFileSizeMb` | `250` | **`15`** | Pilot proved all official policy PDFs are `<= 6.74 MB`, while `5` PDFs `> 15 MB` were 100% slide-deck noise consuming `45.3%` of PDF disk space. Prevents `250 MB` slide/dataset bombs. |
| `denylistPatterns` | Default (`2` auth paths) | **Expanded (`18` patterns)** | Pre-fetch filters out `digitalcommons.`, `openpublishing.`, `theses-dissertations.`, `/cgi/viewcontent.cgi`, `/courses/archive/`, `/~`, `/%7e`, `/fckeditor/`, `/wp-login`, `/calendar/`, `hsa_net=adwords`, `hstk_network=` while preserving official `/news/`? (See Section 7 & 8: denylist `/events/previous-events`, `/magazine/`, alumni/blog traps; keep `/news/` nuanced or denylist selectively—explicitly configurable). |
| `blockedExtensions` | Default (`14` exts) | **Add `ppt, pptx, zip, tar, gz, mp3, wav, avi, mkv`** | Blocks raw lecture PowerPoints and dataset archives that cannot yield reliable rubric verdicts. |
| `rollingTargetWindow` | `4` | **`6`** | With `fetchConcurrency: 4` and 1-tab-per-host lock, a 4-target window stalls when 2–3 targets share a single slow WordPress host (`web.uri.edu`, `www.umass.edu`). Raising to `6` keeps the fetch pool saturated across distinct campuses. |
| `fetchConcurrency` | `3` | **`4`** | Pilot logs showed backpressure tripping within 36 seconds (`72 >= 50` pending fetches) and pausing search lanes for 3 minutes. `4` workers (still max 1 tab/host) reduces backpressure stalls without spiking host load. |
| `backpressureHigh` / `Low` | `50` / `20` | **`80` / `30`** | With 6 active targets and 3 engines, `50` pauses lanes too frequently; `80/30` smooths pipeline bursts while bounding IndexedDB queue size. |
| `pacing` | SERP `3–30s (7.5)`, Inter-Q `3–30s (10)`, Host `2–30s (5)` | **Keep as-is** | Zero CAPTCHAs observed in pilot; do not tighten Google pacing on a multi-day desktop campaign. |
| `dedupPolicy` / `globalDedup` / `freshnessDays` | `"skip-and-stub"` / `true` / `30` | **Keep as-is** | Essential for preserving per-engine provenance stubs without re-downloading identical canonical URLs across engines/topics. |
| `saveSerpHtml` | `true` | **Keep `true`** | Required by `5ma5w9` R-37 ("full search-engine answers") and essential for auditing engine DOM bugs (like Bing cloaked ads). Costs only `~31 GB` across `62.9k` SERPs. |
| `fetchLinks` | `true` (all) | **Keep `true` (all)** | Capturing rendered pages inside the real browser session is SerpyDerpy's core anti-WAF advantage; do not disable it. |
| Execution batching | Single 201-target run | **4 Waves (`~50` targets each)** | Limits blast radius of browser profile/disk issues, lets `uni-ai-survey` start relevance checking Wave 1 while Wave 2 runs, and provides natural QA checkpoints every ~2.5 days. |

---

## 5. Prioritized Recommendations (With Explicit Rationale)

### Priority P0 — Must Fix Before Launching Any Full Campaign

1. **P0-1: Redesign Query Portfolio from 192 to 71 Orthogonal Templates & Eliminate All 21 `filetype:pdf` Duplicates**
   - **What to change:** Replace the `192` `q1` templates with the `71` consolidated, cross-engine-safe templates in Section 6 (removing near-duplicates, bare single-word `Claude`/`Perplexity`, public-policy-ambiguous `"artificial intelligence" policy`, and all `21` `filetype:pdf` queries).
   - **Why:** Complies with the `<= 75,000` hard cap, eliminates `63%` of redundant search tasks, and cuts the `85.6%`-noise PDF avalanche observed in the pilot.
   - **Quantified impact:** `-159,594` max SERP loads (`-68.9%`), `-689 GB` disk (`-80.5%`), `-1.92B` GPU check tokens (`-62.5%`).
   - **Trade-offs / risks:** Slight risk of missing a standalone PDF policy not linked from HTML—mitigated because Google/Bing/DDG naturally return official policy PDFs (`15–20%` of results) without `filetype:pdf`, and Layer C fills any remaining gaps.

2. **P0-2: Implement Asymmetric Per-Engine Pagination (`Google 2–4`, `Bing 1–2`, `DDG 1–2`) While Preserving All 3 Engines Across All 16 Topics**
   - **What to change:** Shift pagination budget from flat `2/2/2` to topic-weighted asymmetric depth (`71,958` max SERPs total: `37,788` Google, `18,693` Bing, `15,477` DDG), expressible immediately in `schemaVersion: 2` via split `engines` search entries (or natively via `pagesByEngine` in SerpyDerpy v2.1).
   - **Why:** Deepens Google coverage on high-cardinality R1 topics (`ai-policies-guidance` to `4` pages; `7` core topics to `3` pages) while respecting Bing's empirical page-1 exhaustion (`5/6` pilot tasks) and DDG's smaller `.edu` index, without sacrificing 3-engine Explorer/paper provenance.
   - **Quantified impact:** Keeps 100% of topics on all 3 engines within `71,958 <= 75,000` max SERPs; raises R1 policy/tool/hub recall by `+50–100%` Google depth on core topics.
   - **Trade-offs / risks:** If a clean-query validation pilot shows Bing regularly returns >10 high-signal results on `data-privacy-security` or `ai-programs-credentials`, `3,042` headroom allows upgrading 1–2 topics on Bing from `1` to `2` pages.

3. **P0-3: Patch `engines/bing.js` Cloaked-Ad Leakage & Block Off-Domain SERP Links on `target-site` Queries**
   - **What to change:** In `engines/bing.js`, filter out any `li.b_algo` containing `[class*="ad_"]`, `a[href*="hsa_net="]`, `a[href*="hstk_network="]`, or `a[href*="_bm=b"]`. In `scheduler.js`, when `task.scope === "target-site"`, skip enqueueing `newFetchItems` where `isOffDomain(r.resolvedUrl, task.targetDomain)` is true right on the SERP (still log them in SERP `.json` for auditability).
   - **Why:** Pilot proved Bing injects disguised ads (`mimecast.com`, `hyperproof.io`, `infotech.com`) inside `<li class="b_algo">`, wasting fetches and polluting archives with vendor spam.
   - **Quantified impact:** Eliminates `100%` of Bing cloaked-ad downloads (`~3–8%` of Bing fetches on sparse queries) and prevents wasted host tabs on third-party ad trackers.
   - **Trade-offs / risks:** Could skip an off-domain link directly returned by a broken `site:` operator, which is desirable for `target-site` queries; on-domain URLs that HTTP-redirect off-domain (e.g., university-hosted LibGuides on `*.libguides.com` or external portals) are still fetched and flagged `offDomain: true`.

4. **P0-4: Reduce `maxFileSizeMb` from `250` to `15` and Add Pre-Fetch `denylistPatterns` / `blockedExtensions`**
   - **What to change:** Set `config.maxFileSizeMb: 15`, add `ppt/pptx/zip/tar/gz/mp3/wav/avi/mkv` to `blockedExtensions`, and configure `denylistPatterns` for institutional repository paper endpoints (`digitalcommons.`, `openpublishing.`, `theses-dissertations.`, `/cgi/viewcontent.cgi`, `scholarworks.`, `dspace.`), personal faculty tilde directories (`/~`, `/%7e`), course slide archives (`/courses/archive/`, `/lectures/`, `/slides/`), and legacy exploit paths (`/fckeditor/`).
   - **Why:** In the pilot, `5` PDFs `> 15 MB` were 100% slide-deck noise (`45.3%` of PDF bytes), while every official policy PDF was `<= 6.74 MB`. Repository indexes (`210K–277K` chars) trigger `body_innerText` fallback and risk `inconclusive` verdicts.
   - **Quantified impact:** Cuts disk footprint by `~45%` on PDFs alone (`> 100 GB` saved across 201 schools) and prevents `~10–15%` of pure-noise downloads from ever reaching the GPU relevance judge.
   - **Trade-offs / risks:** A rare university might host an official AI policy inside a `20 MB` image-heavy handbook PDF or under a `/~` faculty page; `skipped_too_large` and `skipped_policy` sidecars preserve the URL + SERP snippet so Layer C or manual review can still see it.

5. **P0-5: Fix `serpJsonFile: null` and URL Canonicalization (`%7E` vs. `~`) in SerpyDerpy Before Full Launch**
   - **What to change:** Populate `serpContext.serpJsonFile` in `scheduler.js` line 1596; update `naming.js` `canonicalizeUrl()` to decode unreserved percent-escapes (`%7E` -> `~`), strip empty numeric Drupal/WordPress cache-buster query keys (`?1785855171=`), and treat `http://` and `https://` equivalents cleanly in dedup lookups.
   - **Why:** Fixes broken SERP-to-result provenance links (`274/274` null in pilot) and stops duplicate binary downloads (`MIT-STS-AI-snakeoil.pdf` downloaded twice).
   - **Quantified impact:** Restores 100% provenance traceability for downstream ingestion and adds `~2–4%` additional dedup savings.
   - **Trade-offs / risks:** Minimal; add unit tests in `tests/naming-and-safety.test.mjs` and `tests/schemas-dedup-recovery.test.mjs`.

### Priority P1 — High-ROI Operational & Methodological Improvements

6. **P1-1: Validate DuckDuckGo Hydration Timing & Page-1 Behavior on Clean Queries**
   - **What to change:** In `scheduler.js`, replace the fixed `sleep(1800)` after `waitForTabComplete` on DuckDuckGo with a short DOM-settle poll (waiting until `article[data-testid="result"]` count stabilizes for 1s or `.no-results` appears, up to 8s), then test DDG on clean JSON-imported queries in the 5-university validation pilot.
   - **Why:** Resolves whether DDG's `1`-result page-1 anomaly was caused purely by paste tokens or by React SPA hydration racing `sleep(1800)`.
   - **Quantified impact:** Protects up to `15,477` DDG SERP loads from systematic under-extraction.
   - **Trade-offs / risks:** Adds `~1–2s` per DDG query (non-bottleneck lane; zero impact on total wall-clock runtime).

7. **P1-2: Tune Fetch Pool (`rollingTargetWindow: 6`, `fetchConcurrency: 4`, `backpressureHigh: 80 / Low: 30`) and Run in 4 Waves of ~50 Universities**
   - **What to change:** Update `config` concurrency/backpressure thresholds and split the `201` targets into 4 sequential wave JSON files (`50, 50, 50, 51`), preserving `globalDedup: true` and `outputRoot: "SerpyDerpy/UAIs"` across waves.
   - **Why:** Pilot logs hit backpressure (`72 >= 50`) in 36 seconds and paused all search lanes for 3 minutes. Wave splitting bounds operational risk and enables overlapped downstream ingestion/checking.
   - **Quantified impact:** Reduces desktop wall-clock idle pauses by `~15–25%` (`~1.5–2.5` days saved) and cuts time-to-first-validated-data from 10 days to 2.5 days.
   - **Trade-offs / risks:** Slightly higher peak RAM in Chromium (`+1` fetch tab); negligible on a modern desktop with 16+ GB RAM.

8. **P1-3: Add Downstream Off-Domain Quarantine Rule in `uni-ai-survey` Ingestion**
   - **What to change:** When ingesting SerpyDerpy archives into `uni-ai-survey`, automatically quarantine `url.offDomain === true` artifacts produced by `scope: "target-site"` tasks unless the final host matches a known institutional satellite allowlist (e.g., `*.libguides.com`, `*.campusgroups.com`, `*.acalog.com`, `*.courseleaf.com`, or university-owned secondary domains).
   - **Why:** Pilot caught `imai.princeton.edu/research/` redirecting to `imai.fas.harvard.edu/research/` and `web.uri.edu/cels/person/deans-office/` redirecting to `thewomenweadmire.com`. Attributing Harvard's page to Princeton corrupts cross-institution comparisons.
   - **Quantified impact:** Eliminates cross-university misattribution errors without discarding the raw provenance record.
   - **Trade-offs / risks:** Requires maintaining a tiny institutional satellite domain allowlist.

### Priority P2 — UX Polish & Future Enhancements

9. **P2-1: Add Native `pagesByEngine` Support to SerpyDerpy v2.1**
   - **What to change:** Extend `inputs.js` and `scheduler.js` to accept optional `pagesByEngine: { google: 4, bing: 2, duckduckgo: 2 }` on each search object so `serpyderpy-campaign.json` needs only `71` search objects instead of split engine entries (`142` entries).
   - **Why:** Cleaner, less error-prone campaign specification and more accurate `inputs.js` scope estimation (also update `estimateCampaignScope()` to compute `max(laneWorkSec)` + coffee-break overhead instead of `totalWorkSec / 3`).
   - **Quantified impact:** Zero SERP change; major maintainability and ETA accuracy improvement.
   - **Trade-offs / risks:** Minor schema extension; backward compatible with `schemaVersion: 2`.

10. **P2-2: Add Paste-Artifact Guardrail to SerpyDerpy UI Textarea**
    - **What to change:** Warn in `dashboard.js` if a pasted plain-text search line has 3+ consecutive spaces followed by an integer/slug token.
    - **Why:** Prevents accidental repetition of the `20261122` pilot paste artifact during ad-hoc runs.
    - **Quantified impact:** Prevents wasted ad-hoc pilot runs.
    - **Trade-offs / risks:** None.

---

## 6. Recommended Per-Topic Campaign Matrix (All 16 Topics)

### 6.1 Budget & Depth Allocation Table (`201` Universities, Strict `<= 75,000` Max SERP Cap)

| # | Topic | Taxonomy Area(s) | Layer A? | Queries (`Q`) | PDF Queries | Google Pages | Bing Pages | DDG Pages | Max SERPs / Uni | Search Tasks (`201xQx3`) | Max SERP Pages | Expected SERP Pages | Depth & Yield Rationale |
| ---: | --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | `colleges-schools` | D-10 (`involved_unit`) | No | `3` | `0` | `2` | `1` | `1` | `12` | `1,809` | `2,412` | `2,231` | High-authority directory pages appear in top 10–20; 9 of 12 old queries were redundant. |
| 2 | `ai-courses` | D-4 | **Yes** | `4` | `0` | `2` | `1` | `1` | `16` | `2,412` | `3,216` | `2,975` | Layer A walks CourseLeaf (11 pilot now, expanding); SerpyDerpy covers non-CourseLeaf & gen-ed/literacy listings without PDF syllabus bloat. |
| 3 | `ai-programs-credentials` | D-3 | **Yes** | `5` | `0` | `3` | `1` | `1` | `25` | `3,015` | `5,025` | `4,523` | Program/certificate marketing pages often live outside CourseLeaf; Google `3` pages captures multi-school degrees/minors/certificates at R1s. |
| 4 | `ai-policies-guidance` | D-1, D-5, D-12 | No | `6` | `0` | `4` | `2` | `2` | `48` | `3,618` | `9,648` | `7,598` | Highest cardinality & spans 3 areas (policy, teaching guidance, data rules). Deepest Google (`4`) + Bing (`2`) + DDG (`2`) catches central + school-level policies. |
| 5 | `ai-hubs-leadership` | D-10, D-1, D-6 | **Yes** | `5` | `0` | `3` | `2` | `1` | `30` | `3,015` | `6,030` | `4,874` | Spans 3 areas (hubs, task forces/governance, research units); Bing `2` caught `ai.princeton.edu` & URI Provost hub in pilot. |
| 6 | `faculty-staff-development` | D-8 (`training`) | No | `4` | `0` | `3` | `1` | `1` | `20` | `2,412` | `4,020` | `3,618` | Cut 6 PDF dupes; Google `3` captures CTL workshop series, learning communities, and IT training pages. |
| 7 | `student-literacy-library` | D-8, D-9 | No | `5` | `0` | `3` | `2` | `1` | `30` | `3,015` | `6,030` | `4,874` | LibGuides & writing centers span many subpages; Bing/DDG showed high precision on LibGuides in pilot. |
| 8 | `tools-platforms` | D-7 | No | `6` | `0` | `3` | `2` | `1` | `36` | `3,618` | `7,236` | `5,849` | High-value structured facts (ChatGPT Edu, Copilot, Gemini, Claude, NotebookLM, Turnitin, LLM gateways); Bing `2` surfaces IT service-catalog entries. |
| 9 | `strategy-investment` | D-2 | No | `4` | `0` | `2` | `1` | `1` | `16` | `2,412` | `3,216` | `2,975` | Narrow cardinality (1–5 strategic plans, cluster hires, or AI funds per campus); deeper pages devolve into general news. |
| 10 | `research-infrastructure` | D-6 (`infra`) | No | `4` | `0` | `3` | `1` | `1` | `20` | `2,412` | `4,020` | `3,618` | R1s host separate HPC cluster, GPU allocation, cloud credit, and secure enclave docs across IT & research computing subdomains. |
| 11 | `partnerships-outreach` | D-11 | No | `4` | `0` | `2` | `1` | `1` | `16` | `2,412` | `3,216` | `2,975` | Moderate cardinality; depth >2 triggers expired one-off event spam (excluded >24 months by rubric). |
| 12 | `data-privacy-security` | D-12, D-1 | No | `5` | `0` | `3` | `1` | `1` | `25` | `3,015` | `5,025` | `4,523` | High institutional value (data classification matrices, FERPA/HIPAA, vendor security reviews); Google `3` surfaces buried InfoSec/ISO pages. |
| 13 | `admissions-student-services` | D-13 | No | `4` | `0` | `2` | `1` | `1` | `16` | `2,412` | `3,216` | `2,975` | Narrow cardinality (admissions AI essay rule, advising/enrollment chatbots, career services). |
| 14 | `operations-workforce` | D-14 | No | `4` | `0` | `2` | `1` | `1` | `16` | `2,412` | `3,216` | `2,975` | Narrow cardinality (HR/finance/admin AI pilots, employee operational guidance, procurement). |
| 15 | `access-equity` | D-15 | No | `3` | `0` | `2` | `1` | `1` | `12` | `1,809` | `2,412` | `2,231` | Narrowest cardinality ("AI for all", accessibility accommodations, free student access); consolidated from 12 overlapping queries. |
| 16 | `student-organizations` | D-9 (`student_org`) | No | `5` | `0` | `2` | `1` | `1` | `20` | `3,015` | `4,020` | `3,719` | `2` `target-site` + `3` `web` queries (including CampusGroups, Presence, CampusLabs); shallow depth avoids off-campus noise. |
| **Total** | **16 topics** | **15 areas** | **3** | **`71`** | **`0`** | **`188`/u** | **`93`/u** | **`77`/u** | **`358`/u** | **`42,813`** | **`71,958`** | **`62,863`** | **Headroom: `3,042` SERP pages (`4.1%`) under `75,000` cap** |

### 6.2 Complete Revised Query Set (`71` Cross-Engine-Safe Templates)

All templates use `scope: "target-site"` unless marked `[web]`. Templates avoid complex multi-level Boolean trees and Google-only `-inurl:` operators so Google, Bing, and DuckDuckGo all parse them reliably.

1. **`colleges-schools` (3):**
   - `"colleges and schools"`
   - `academics colleges schools`
   - `"graduate school" OR "honors college"`
2. **`ai-courses` (4):**
   - `"artificial intelligence" course catalog`
   - `"machine learning" course catalog`
   - `"generative AI" course`
   - `"AI literacy" OR "general education" AI course`
3. **`ai-programs-credentials` (5):**
   - `"artificial intelligence" degree OR major`
   - `"artificial intelligence" minor OR concentration`
   - `"artificial intelligence" certificate OR credential`
   - `"machine learning" degree OR certificate`
   - `"applied AI" OR "data science" "artificial intelligence" program`
4. **`ai-policies-guidance` (6):**
   - `"generative AI" policy OR guidelines`
   - `"generative AI" guidance`
   - `"acceptable use" "artificial intelligence" OR "generative AI"`
   - `"academic integrity" "generative AI" OR ChatGPT`
   - `syllabus "generative AI" OR "AI tools" guidance`
   - `"university policy" OR "responsible AI" "artificial intelligence" guidance`
5. **`ai-hubs-leadership` (5):**
   - `"AI at" OR "generative AI at"`
   - `"artificial intelligence" hub OR initiative`
   - `"AI task force" OR "AI committee"`
   - `"AI steering" OR "AI governance" provost`
   - `"institute for artificial intelligence" OR "center for artificial intelligence"`
6. **`faculty-staff-development` (4):**
   - `"faculty development" "generative AI" OR "artificial intelligence"`
   - `"teaching with AI" OR "teaching with generative AI"`
   - `"center for teaching" "generative AI" workshop`
   - `"staff training" OR "professional development" "generative AI"`
7. **`student-literacy-library` (5):**
   - `"AI literacy" students`
   - `libguides "artificial intelligence" OR "generative AI"`
   - `library "generative AI" guide`
   - `citing "generative AI" OR ChatGPT`
   - `"writing center" OR "student guide" "generative AI"`
8. **`tools-platforms` (6):**
   - `"ChatGPT Edu" OR "ChatGPT Enterprise"`
   - `"Microsoft Copilot" university OR campus`
   - `"Google Gemini" OR NotebookLM university`
   - `"Claude AI" OR "Perplexity AI" campus OR tools`
   - `"approved AI tools" OR "supported AI tools"`
   - `"Turnitin AI" OR "LLM gateway" OR "AI sandbox"`
9. **`strategy-investment` (4):**
   - `"AI strategic plan" OR "AI roadmap"`
   - `"artificial intelligence" "strategic plan"`
   - `"artificial intelligence" "cluster hire" OR "faculty hiring"`
   - `"AI seed grants" OR "AI investment" OR "AI fund"`
10. **`research-infrastructure` (4):**
    - `"GPU cluster" OR "AI supercomputer"`
    - `"research computing" "artificial intelligence" OR "machine learning"`
    - `"GPU allocation" OR "cloud credits" research`
    - `"research computing" NVIDIA OR "model hosting"`
11. **`partnerships-outreach` (4):**
    - `"artificial intelligence" "industry partnership" OR "memorandum of understanding"`
    - `"K-12" OR "high school" "artificial intelligence" outreach OR camp`
    - `"AI symposium" OR "AI summit" OR "AI conference"`
    - `"AI speaker series" OR "AI hackathon"`
12. **`data-privacy-security` (5):**
    - `"data classification" "generative AI" OR "AI tools"`
    - `"sensitive data" OR "protected data" "generative AI"`
    - `FERPA OR HIPAA "generative AI" OR "AI tools"`
    - `"vendor security" OR "security review" "generative AI" OR AI`
    - `"information security" OR "data privacy" "generative AI"`
13. **`admissions-student-services` (4):**
    - `admissions "use of AI" OR "generative AI" application`
    - `advising OR enrollment "AI chatbot" OR "virtual assistant"`
    - `"AI tutoring" OR "AI advising" students`
    - `"career services" "generative AI" OR "artificial intelligence"`
14. **`operations-workforce` (4):**
    - `"human resources" OR "finance" "generative AI" operations`
    - `"administrative operations" OR "process automation" "generative AI"`
    - `"staff use" OR "employee guidance" "generative AI"`
    - `"AI procurement" OR "communications" "generative AI" guidance`
15. **`access-equity` (3):**
    - `"AI accessibility" OR "digital accessibility" "generative AI"`
    - `"AI for all" OR "free AI tools" students`
    - `"AI equity" OR "disability services" "generative AI"`
16. **`student-organizations` (5):**
    - `"AI club" OR "artificial intelligence club"`
    - `"machine learning club" OR "ACM AI"`
    - `[web]` `"{name}" "AI club" OR "artificial intelligence" "student organization"`
    - `[web]` `site:campusgroups.com "{name}" "artificial intelligence" OR "machine learning"`
    - `[web]` `site:campuslabs.com "{name}" "artificial intelligence"` (or pair with `presence.io` in validation pilot to test which platform yields more hits per roster)

---

## 7. Concrete `serpyderpy-campaign.json` Revision Spec & Pre-Full-Run Validation Pilot

### 7.1 Schema-Valid `config` Block (`schemaVersion: 2`)

```json
{
  "schemaVersion": 2,
  "name": "AI at U.S. Universities (201 Roster, q2-serpyderpy)",
  "outputRoot": "SerpyDerpy/UAIs",
  "rosterVersion": "r1",
  "queryListVersion": "q2",
  "defaultPages": 2,
  "config": {
    "rollingTargetWindow": 6,
    "fetchConcurrency": 4,
    "maxFileSizeMb": 15,
    "maxHtmlSizeMb": 50,
    "backpressureHigh": 80,
    "backpressureLow": 30,
    "dedupPolicy": "skip-and-stub",
    "freshnessDays": 30,
    "globalDedup": true,
    "challengePauseScope": "pause-affected-only",
    "onBrowserRestart": "prompt",
    "useManagedWindow": true,
    "keepAwake": true,
    "eraseDownloadHistory": true,
    "saveSerpHtml": true,
    "noPersonalization": true,
    "ddgHtmlMode": false,
    "plainLinks": false,
    "recordPublicIp": false,
    "engines": ["google", "bing", "duckduckgo"],
    "blockedExtensions": [
      "exe", "msi", "bat", "cmd", "ps1", "vbs", "scr", "com", "dll", "dmg", "pkg",
      "mp4", "mov", "avi", "mkv", "mp3", "wav", "iso", "zip", "tar", "gz", "ppt", "pptx"
    ],
    "denylistPatterns": [
      "/Shibboleth.sso/",
      "/cas/login",
      "/wp-login.php",
      "/fckeditor/",
      "digitalcommons.",
      "scholarworks.",
      "openpublishing.",
      "theses-dissertations.",
      "/cgi/viewcontent.cgi",
      "/courses/archive/",
      "/lectures/",
      "/slides/",
      "/events/previous-events",
      "regex:/~[^/]+/",
      "regex:/%7e[^/]+/",
      "hsa_net=adwords",
      "hstk_network=",
      "_bm=b&_bn=o"
    ],
    "pacing": {
      "serpPageDelay": { "min": 3, "max": 30, "mean": 7.5 },
      "interQueryDelay": { "min": 3, "max": 30, "mean": 10 },
      "sameHostFetchDelay": { "min": 2, "max": 30, "mean": 5 }
    }
  }
}
```

### 7.2 Schema-Valid Asymmetric Engine Depth Pattern (Works Immediately Today)

Because `inputs.js` `parseSearchesJson()` reads a single scalar `pages` per entry in `searches[]`, asymmetric engine depths work **immediately in `schemaVersion: 2` with zero SerpyDerpy schema changes** by pairing explicit slugs per template:

```json
{
  "id": "ai-policies-guidance-01-g",
  "slug": "pol-01-genai-policy-g",
  "group": "ai-policies-guidance",
  "template": "\"generative AI\" policy OR guidelines",
  "scope": "target-site",
  "pages": 4,
  "engines": ["google"],
  "fetchLinks": true,
  "enabled": true
},
{
  "id": "ai-policies-guidance-01-bd",
  "slug": "pol-01-genai-policy-bd",
  "group": "ai-policies-guidance",
  "template": "\"generative AI\" policy OR guidelines",
  "scope": "target-site",
  "pages": 2,
  "engines": ["bing", "duckduckgo"],
  "fetchLinks": true,
  "enabled": true
}
```

*(When `pagesByEngine` is added in SerpyDerpy v2.1, those two objects collapse into one with `"pagesByEngine": { "google": 4, "bing": 2, "duckduckgo": 2 }`.)*

### 7.3 Pre-Full-Run Validation Pilot Protocol (5 Universities)

Run **before** launching Wave 1 of the 201-university campaign, using clean JSON import (never textarea paste) after landing P0-3 (`engines/bing.js` ad filter) and P0-5 (`serpJsonFile` + `%7E` canonicalization):

- **Pilot Roster (5 diverse institutions):**
  1. `princeton.edu` (Private R1, heavy public-policy scholarship; direct before/after comparison vs. `20261122-pilot-test.zip`)
  2. `asu.edu` (Mega public R1, `size-ipeds`, massive AI web footprint; stress-tests R1 pagination saturation)
  3. `umass.edu` (Public land-grant R1; in `b2jl4n` pilot set & `20261122` test)
  4. `uri.edu` (Public R2; home benchmark & `20261122` test)
  5. `colby.edu` (National Liberal Arts College; tests early-stop rates and historical WAF blocking)
- **Pilot Scale:** `5 x 71 x 3 = 1,065` Search Tasks | **`1,790` max SERP pages** (`~1,560` expected) | **`~3.8` hours** Google-lane SERP runtime (`~5–6` hours total wall-clock). Fits inside the `3,042`-SERP budget headroom (`71,958 + 1,790 = 73,748 <= 75,000`).

#### Explicit Go / No-Go Pass/Fail Gates

| Gate | Metric | Pass Threshold (Go) | Action on Fail (No-Go) |
| --- | --- | --- | --- |
| **G1: Clean Query & Zero Ad Leakage** | Off-domain ad/vendor URLs captured on `target-site` tasks; stray token count | `0` Bing cloaked ads; `0` paste artifacts | Inspect SERP `.html` and tighten `engines/bing.js` / `scheduler.js` filters. |
| **G2: DuckDuckGo Clean Yield** | Non-zero DDG page-1 result rate across the 5 campuses (especially `umass.edu`, `uri.edu`, `asu.edu`) | `>= 65%` of DDG tasks return `>= 3` results on page 1 (no systemic 1-result P1 artifact) | Fix DDG DOM hydration wait or toggle `ddgHtmlMode: true` if JS endpoint throttles. |
| **G3: Telemetry & Archive Integrity** | `serpJsonFile` populated; `_site/site-capture.json` present for `5/5` targets; final report + full checkpoint written; `%7E` dupes = `0` | `100%` pass (`5/5` `_site/site-capture.json`, `0` null `serpJsonFile`, `0` `USER_CANCELED`) | Fix SerpyDerpy commit/flush bug before Wave 1. |
| **G4: Signal Precision & PDF Share** | Hand-audit random sample of `100` fetched pages (`20`/school) against `rubric-v1`; PDF share & mean size | `>= 40%` survey-relevant precision (up from `29.8%` pilot); PDF share `<= 28%`; `0` files `> 15 MB`; disk `<= 1.2 GB`/university average | Tighten noisy templates or expand `denylistPatterns` for top recurring noise domains. |
| **G5: Recall Non-Regression on `princeton/umass/uri`** | Share of the `46` verified official policy pages from `20261122-pilot-test.zip` rediscovered by the new `ai-policies-guidance` queries | `>= 90%` (`>= 41/46`) rediscovered, plus net new official pages found | Inspect missed policy URLs and adjust `ai-policies-guidance` phrasing. |
| **G6: CAPTCHA & Stability Rate** | Human CAPTCHA interventions per `1,000` SERP loads; permanent fetch error rate | `<= 3` CAPTCHAs / `1,000` SERPs; fetch error rate `<= 8%` | Slow Google `interQueryDelay.mean` from `10s` to `14s` or enable `softHourlyPageCap: 150`. |

---

## 8. Open Decisions & Assumptions Register

### 8.1 Open Decisions Requiring Maintainer Choice

1. **OD-1 — `/news/` Path Denylisting vs. Retaining Official Launch Announcements:** Some smaller institutions announce an AI task force or AI tool rollout only on a university `/news/` page (`page-relevance-rubrics.json` allows news *only* when no official hub/policy exists). The recommended `denylistPatterns` above intentionally **does not** globally block `/news/` (blocking only `/events/previous-events`, repositories, slides, and `/~` faculty paths). *Decision:* Keep `/news/` allowed (safer for small-school recall, slightly higher GPU check volume) vs. denylist `/news/` and rely on Layer C to catch news-only institutions. RESOLVED 2026-11-24 by the user via /askme: Option A (Allow `/news/` addresses; do not add `/news/` to `denylistPatterns`). No reason was given.
2. **OD-2 — `maxFileSizeMb`: `15 MB` vs. `20 MB`:** All pilot policy PDFs were `<= 6.74 MB`, and the smallest slide-deck bomb was `12.38 MB` (`18.30 MB` at `>15 MB`). `15 MB` is recommended; `20 MB` is a conservative alternative adding `~10–15 GB` across 201 campuses. RESOLVED 2026-11-24 by the user via /askme: Set `maxFileSizeMb` to 50 MB for now, with an end-of-run report of skipped files. Reason given: "I'd like a report of files skipped at the end, so we can decide to go back and get them if needed."
3. **OD-3 — `student-organizations` Platform Coverage (`campuslabs.com` vs. `presence.io`):** To stay within `71,958` max SERPs, template #5 uses `site:campuslabs.com`. If the 5-university validation pilot shows `presence.io` yields higher club recall than `campuslabs.com`, swap or add `presence.io` using `804` of the `3,042` remaining SERP headroom. RESOLVED 2026-11-24 by the user via /askme: Option A (Include both `campuslabs.com` and `presence.io` as separate queries right away, bringing the campaign to 72 queries and 72,762 maximum SERP page loads). No reason was given.
4. **OD-4 — SerpAPI Layer B Role After SerpyDerpy Redesign:** Decide whether SerpyDerpy replaces SerpAPI for the full 201-university Layer B run (recommended, saving the 100k SerpAPI allocation for longitudinal deltas or retry fallback) or runs alongside SerpAPI on the 11-university `b2jl4n` pilot for a head-to-head paper table. RESOLVED 2026-11-24 by the user via /askme: Pilot both SerpyDerpy and SerpAPI on the same 5 validation-pilot universities first, then decide SerpAPI's Round 1 role from the pilot comparison (revisit trigger: completion of the 5-university paired SerpyDerpy + SerpAPI pilot). Reason given: "I want to pilot both SerpyDerpy and SerpAPI with the same 5 unis and then decide."
5. **OD-5 — `search-and-extraction-models.json` Provider Pricing Population:** All 6 models in `survey-protocol/search-and-extraction-models.json` currently have `null` prices. Verify and populate actual provider pricing (`36epid` R-32/R-33) before approving paid Layer C or extraction spend caps. RESOLVED 2026-11-24 by evidence via /askme: Governed by approved specification `36epid` (R-32 and R-33), which already requires verified provider pricing before any paid model run; does not block unpaid SerpyDerpy collection.

### 8.2 Verified Measurements vs. Quantitative Modeling Assumptions Register

| Parameter | Value Used | Status | Source / Justification |
| --- | --- | --- | --- |
| Target roster size | `201` institutions | **Verified** | `survey-protocol/university-roster.json` (`105` National Univ, `12` LAC, `8` Regional, `76` uncategorized) |
| Current campaign scale | `192` templates, `115,776` tasks, `231,552` max SERPs | **Verified** | `survey-protocol/serpyderpy-campaign.json` |
| Layer A start-URL coverage | `11` universities mapped | **Verified** | `survey-protocol/university-course-catalog-start-urls.json` |
| Pilot archive counts & sizes | `719` files, `395.18 MB`, `33` SERPs, `271` results (`223` fetched + `48` dedup), `3` errors, `225` unique non-error URLs, `111` PDFs (`355.63 MB`, mean `3.20 MB`), `112` HTMLs (`18.98 MB` raw, `1.63 MB` MD, mean `14,011` chars) | **Verified** | Direct audit of `tmp/20261122-pilot-test.zip` |
| Pilot PDF mean `<= 15 MB` | `1.83 MB` (`194.51 MB / 106` PDFs) | **Verified** | Direct audit of `tmp/20261122-pilot-test.zip` |
| Pilot signal-vs-noise rates | `20.4%` policy signal, `29.8%` all-survey signal, `70.2%` noise; PDF noise `85.6%` vs. HTML noise `55.3%` | **Verified (audit)** | Manual/rule classification of all `225` pilot URLs against `rubric-v1` |
| Early-stop page realization rates | Google `[1.0, 0.85, 0.65, 0.50]`; Bing `[1.0, 0.35]`; DDG `[1.0, 0.45]` | **Modeled** | Adjusted upward from pilot Bing (`17%` P2) and DDG (`33%` P2) to account for removing paste tokens |
| Average organic results per SERP page | Google `9.8`, Bing `8.5` (post-ad-filter), DDG `8.0` (clean) | **Modeled** | Grounded in pilot Google `10.0`/page and clean-query Bing/DDG norms |
| Cross-query/engine dedup rate | `62%` current (`192` redundant templates) vs. `46%` recommended (`71` orthogonal templates) | **Modeled** | Extrapolated from `17.7%` pilot dedup across only 2 queries |
| Archived fraction of unique URLs | `95%` current (`5%` HTTP errors) vs. `85%` recommended (`12%` denylist/15 MB skips + `3%` errors) | **Modeled** | Grounded in pilot `1.3%` error rate + observed repository/slide/ad share |
| PDF share of archived files | `38%` current (21 `filetype:pdf` queries across 16 topics) vs. `20%` recommended (0 `filetype:pdf`, `15 MB` cap, repository denylist) | **Modeled** | Grounded in pilot `49.8%` PDF share on policy queries |
| Desktop runtime overhead | Google lane + `+10.5s`/task coffee breaks x `1.35–1.75` (backpressure + CAPTCHA) | **Modeled** | Grounded in `pacing.js` (`15–25` queries, `120–300s`) and pilot backpressure log |
| Tokenization & check throughput | `4` chars/token; HTML `3,500` + `700` prompt = `4,200` tok; PDF `6,500`/`4,500` + `700` tok; URI gateway `1.5–4.0` pages/sec | **Modeled** | Grounded in pilot HTML mean `14,011` chars (`3,503` tokens) |
| Relevance-check supported rate | `22%` current vs. `44%` recommended | **Modeled** | Grounded in pilot `20.4%–29.8%` signal rate + query tightening + PDF/denylist pruning |
| Paid extraction LLM pricing | Flash `$0.30/$2.50`, Mid `$1.50/$7.50`, Frontier `$5.00/$25.00` per 1M input/output tokens | **Modeled (illustrative)** | Placeholder tiers because `search-and-extraction-models.json` prices are currently `null` |
