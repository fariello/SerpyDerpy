import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseRosterText,
  parseRosterCsv,
  parseRosterJson,
  parseSearchesText,
  parseSearchesJson,
  expandSearchTemplate,
  validateCampaignInputs,
  estimateCampaignScope
} from "../inputs.js";
import * as googleAdapter from "../engines/google.js";
import * as bingAdapter from "../engines/bing.js";
import * as ddgAdapter from "../engines/duckduckgo.js";
import { evaluateTargetChallenge } from "../schemas.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("REQ-INPUT-01..09 & V-02: generic roster & search loaders, precedence, scope, and validation", async () => {
  // Plain text roster + comments + protocols stripped
  const rTxt = await parseRosterText("# Car companies\nhttps://www.toyota.com/\nford.com\nbad domain\n");
  assert.equal(rTxt.targets.length, 2);
  assert.equal(rTxt.targets[0].domain, "toyota.com");
  assert.equal(rTxt.targets[0].slug, "toyota-com");
  assert.equal(rTxt.errors.length, 1);

  // CSV roster preserves extra columns inside metadata
  const rCsv = await parseRosterCsv("domain,name,external_id,sector,country\ntoyota.com,Toyota Motor,TM,automotive,JP\n");
  assert.equal(rCsv.errors.length, 0);
  assert.equal(rCsv.targets[0].externalId, "TM");
  assert.equal(rCsv.targets[0].metadata.sector, "automotive");
  assert.equal(rCsv.targets[0].metadata.country, "JP");

  // JSON searches precedence: per-search pages > defaultPages > global (3)
  const sJson = await parseSearchesJson(
    {
      schemaVersion: 2,
      defaultPages: 5,
      searches: [
        { template: '"factory robotics" {metadata.country}', pages: 7 },
        { template: '"supply chain"' },
        { template: 'site:sec.gov "{name}" robotics', scope: "web" }
      ]
    },
    { campaignDefaultPages: 3 }
  );
  assert.equal(sJson.errors.length, 0);
  assert.equal(sJson.searches[0].pages, 7);
  assert.equal(sJson.searches[1].pages, 5);
  assert.equal(sJson.searches[2].scope, "web");

  // Template expansion with metadata.<key> and target-site site:{domain} prefix
  const exp1 = expandSearchTemplate(sJson.searches[0], rCsv.targets[0]);
  assert.equal(exp1.ok, true);
  assert.equal(exp1.resolvedQuery, 'site:toyota.com "factory robotics" JP');

  // Web scope sends template as written
  const expWeb = expandSearchTemplate(sJson.searches[2], rCsv.targets[0]);
  assert.equal(expWeb.ok, true);
  assert.equal(expWeb.resolvedQuery, 'site:sec.gov "Toyota Motor" robotics');

  // target-site template containing site: must FAIL validation (REQ-INPUT-09)
  const badSearches = await parseSearchesText("site:{domain} robotics\t4\nweb:site:sec.gov {name}\t2\n");
  const val = validateCampaignInputs({
    targets: rCsv.targets,
    searches: badSearches.searches,
    outputRoot: "SerpyDerpy/auto"
  });
  assert.equal(val.ok, false);
  assert.ok(val.errors.some((e) => e.includes('contains "site:"')));

  // Missing {name} placeholder warns and blocks when mode is "error"
  const rNoName = await parseRosterJson({ targets: [{ domain: "ford.com" }] });
  const sNeedsName = await parseSearchesJson({ searches: [{ template: '"{name}" EV', scope: "web" }] });
  const valMissing = validateCampaignInputs({
    targets: rNoName.targets,
    searches: sNeedsName.searches,
    outputRoot: "SerpyDerpy/auto",
    missingPlaceholderMode: "error"
  });
  assert.equal(valMissing.ok, false);
  assert.equal(valMissing.missingPlaceholders.length, 1);

  // Scope estimator
  const est = estimateCampaignScope({
    targets: rCsv.targets,
    searches: sJson.searches,
    campaignId: "c1"
  });
  assert.equal(est.targets, 1);
  assert.equal(est.searches, 3);
  assert.equal(est.totalSearchTasks, 9); // 1 target * 3 searches * 3 engines
});

test("Section 6.3 & V-04: engine URL builders and click-redirect unwrapping (Google, Bing Base64URL, DDG)", () => {
  // Google
  assert.equal(
    googleAdapter.buildInitialUrl("site:mit.edu AI", { noPersonalization: true }),
    "https://www.google.com/search?q=site%3Amit.edu%20AI&hl=en&gl=us&pws=0"
  );
  assert.equal(
    googleAdapter.unwrapResultUrl("https://www.google.com/url?q=https%3A%2F%2Fmit.edu%2Fai%2F&sa=U").url,
    "https://mit.edu/ai/"
  );

  // Bing unpadded Base64URL ck/a u=a1... decoding with UTF-8
  const targetUrl = "https://www.princeton.edu/news/café-ai?id=42";
  const b64url = Buffer.from(targetUrl, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const bingWrapped = `https://www.bing.com/ck/a?!&&p=123&u=a1${b64url}&ntb=1`;
  const bingRes = bingAdapter.unwrapResultUrl(bingWrapped);
  assert.equal(bingRes.urlDecodeFallback, false);
  assert.equal(bingRes.url, new URL(targetUrl).href);

  // Bing <cite> fallback when u param is corrupt
  const bingFallback = bingAdapter.unwrapResultUrl("https://www.bing.com/ck/a?u=invalid", "mit.edu › ai-policy");
  assert.equal(bingFallback.urlDecodeFallback, true);
  assert.equal(bingFallback.url, "https://mit.edu/ai-policy");

  // DuckDuckGo omits &kp=-2 (OQ-18) and unwraps uddg=
  const ddgUrl = ddgAdapter.buildInitialUrl("site:mit.edu AI");
  assert.equal(ddgUrl.includes("kp="), false);
  assert.equal(ddgUrl, "https://duckduckgo.com/?q=site%3Amit.edu%20AI&kl=us-en&ia=web");
  assert.equal(
    ddgAdapter.unwrapResultUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fmit.edu%2Fpolicy.pdf").url,
    "https://mit.edu/policy.pdf"
  );

  // Bing cloaked ad URL detection (pilot D1 regression test)
  assert.equal(
    bingAdapter.isBingCloakedAdUrl("https://www.mimecast.com/demo/?hstk_creative=&hstk_campaign=581613931&hstk_network=googleAds"),
    true
  );
  assert.equal(
    bingAdapter.isBingCloakedAdUrl("https://hyperproof.io/product/hyperproof-ai/?hsa_net=adwords&hsa_ver=3"),
    true
  );
  assert.equal(
    bingAdapter.isBingCloakedAdUrl("https://www.infotech.com/sem/lp3/ai?_bm=b&_bn=o&_bg=1307320629318475*"),
    true
  );
  assert.equal(
    bingAdapter.isBingCloakedAdUrl("https://its.uri.edu/ai-at-uri/"),
    false
  );
});

test("REQ-FETCH-04 & V-05: corroborated target-page challenge detection against HTML fixtures", () => {
  const cfHtml = fs.readFileSync(path.join(__dirname, "fixtures/cloudflare-interstitial.html"), "utf8");
  const cfResult = evaluateTargetChallenge({
    url: "https://example.edu/ai-policy",
    httpStatus: 403,
    title: "Just a moment...",
    visibleText: "Checking if the site connection is secure",
    selectors: {
      cfChallengeRunning: cfHtml.includes("challenge-running"),
      cfChallengeForm: cfHtml.includes("challenge-form"),
      cfTurnstileIframe: cfHtml.includes("challenges.cloudflare.com")
    }
  });
  assert.equal(cfResult.isChallenge, true);
  assert.equal(cfResult.provider, "cloudflare");

  // Normal long page with embedded footer reCAPTCHA and "Access Denied" docs text must NOT false-positive
  const normalHtml = fs.readFileSync(path.join(__dirname, "fixtures/normal-page-with-recaptcha-footer.html"), "utf8");
  const visibleText = normalHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.ok(visibleText.length >= 1500, "Fixture body should be >= 1500 chars");
  const normalResult = evaluateTargetChallenge({
    url: "https://example.edu/ai-policy-guide",
    httpStatus: 200,
    title: "University AI Policy Guide and Troubleshooting",
    visibleText,
    selectors: {
      recaptcha: true,
      awsWafScript: true,
      awsWafCaptcha: false,
      cfChallengeRunning: false,
      cfChallengeForm: false,
      cfTurnstileIframe: false
    }
  });
  assert.equal(normalResult.isChallenge, false);

  // AWS WAF script tag on a short/202/405 interstitial must trigger, while explicit widget container is standalone
  const awsInterstitial = evaluateTargetChallenge({
    url: "https://careers.umass.edu/jobs/example",
    httpStatus: 202,
    title: "",
    visibleText: "Human Verification",
    selectors: { awsWafScript: true, awsWafCaptcha: false }
  });
  assert.equal(awsInterstitial.isChallenge, true);
  assert.equal(awsInterstitial.provider, "aws-waf");

  const awsWidget = evaluateTargetChallenge({
    url: "https://ziplines.careercatalyst.asu.edu/ai-automation",
    httpStatus: 200,
    title: "Verify",
    visibleText,
    selectors: { awsWafScript: true, awsWafCaptcha: true }
  });
  assert.equal(awsWidget.isChallenge, true);
  assert.equal(awsWidget.provider, "aws-waf");
});
