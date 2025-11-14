import express from 'express';
import morgan from 'morgan';
import { chromium } from 'playwright';
import PQueue from 'p-queue';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT || 4000);
const PROFILE_DIR = process.env.PROFILE_DIR
  ? path.resolve(process.env.PROFILE_DIR)
  : path.resolve('profiles/default');
const HEADLESS = process.env.HEADLESS !== 'false';
const DEFAULT_WAIT_UNTIL = process.env.WAIT_UNTIL || 'networkidle';
const NAVIGATION_TIMEOUT = Number(process.env.NAVIGATION_TIMEOUT || 45000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const EXTRA_ARGS = process.env.BROWSER_ARGS
  ? process.env.BROWSER_ARGS.split(',').map((arg) => arg.trim()).filter(Boolean)
  : [];
const API_KEY = process.env.API_KEY || '';

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(morgan('tiny'));

if (!API_KEY) {
  console.warn('[browser-service] WARNING: API_KEY env var is not set; all requests will be rejected.');
}

const authenticate = (req, res, next) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_KEY is not configured on the server' });
  }
  const providedKey = req.header('x-api-key') || req.query.api_key;
  if (providedKey !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
};

app.use(authenticate);

const queue = new PQueue({ concurrency: CONCURRENCY });
let context;
let sharedPage;
const FALLBACK_SNIPPET_LIMIT = Number(process.env.FALLBACK_SNIPPET_LIMIT || 10);
const FALLBACK_SNIPPET_TIMEOUT = Number(process.env.FALLBACK_SNIPPET_TIMEOUT || 2000);

async function launchBrowser() {
  if (context) {
    try {
      const browser = context.browser();
      if (browser && browser.isConnected()) {
        return context;
      }
    } catch (err) {
      console.warn('[browser-service] existing context invalid, relaunching', err.message);
    }
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--disable-infobars',
      '--lang=en-US,en',
      '--window-size=1280,720',
      ...EXTRA_ARGS,
    ],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  context.on('close', () => {
    context = undefined;
    sharedPage = undefined;
  });

  return context;
}

async function getSharedPage() {
  const ctx = await launchBrowser();
  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await ctx.newPage();
    sharedPage.setDefaultTimeout(NAVIGATION_TIMEOUT);
    sharedPage.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
  }
  return sharedPage;
}

async function runJob(handler) {
  return queue.add(async () => {
    const page = await getSharedPage();
    return handler(page);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decodeHtml = (value) => {
  if (!value) return '';
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .trim();
};

async function fillMissingSnippets(results) {
  if (!Array.isArray(results) || !results.length || FALLBACK_SNIPPET_LIMIT <= 0) {
    return;
  }
  let attempts = 0;
  for (const item of results) {
    if (item.snippet || !item.link || !item.link.startsWith('http')) continue;
    if (attempts >= FALLBACK_SNIPPET_LIMIT) break;
    attempts += 1;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FALLBACK_SNIPPET_TIMEOUT);
      const response = await fetch(item.link, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      clearTimeout(timer);
      if (!response.ok) continue;
      const html = await response.text();
      const metaMatch =
        html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i);
      if (metaMatch && metaMatch[1]) {
        const snippetText = decodeHtml(metaMatch[1]);
        if (snippetText) {
          item.snippet = snippetText;
        }
      }
    } catch (err) {
      // ignore fetch errors
    }
  }
}

function buildBlockerPayload(blocker, meta = {}) {
  return {
    blocked: true,
    blocker,
    ...meta,
  };
}

async function detectAccessBlocker(page, options = {}) {
  const { requiredSelectors = [] } = options;
  try {
    return await page.evaluate(({ requiredSelectors }) => {
      const toLower = (value) => (value || '').toLowerCase();
      const bodyText = toLower(document.body ? document.body.innerText : '');
      const htmlText = toLower(document.documentElement ? document.documentElement.innerHTML : '');

      const collectSelectors = (selectors) =>
        selectors.filter((selector) => {
          try {
            return Boolean(document.querySelector(selector));
          } catch (_err) {
            return false;
          }
        });

      const collectPhrases = (phrases) =>
        phrases.filter((phrase) => bodyText.includes(phrase));

      const cookieSelectors = [
        '#onetrust-banner-sdk',
        '#onetrust-consent-sdk',
        '.osano-cm-window',
        '.truste_overlay',
        '.qc-cmp2-container',
        '.cookie-consent',
        '.cookie-banner',
        '.consent-banner',
        '#cookie-banner',
        '#sp-cc',
        '[id*="cookieconsent"]',
        '[class*="cookie-consent"]',
        '[class*="gdpr-consent"]',
      ];

      const cookiePhrases = [
        'we use cookies',
        'cookie policy',
        'accept all cookies',
        'manage cookies',
        'consent to cookies',
        'your cookie preferences',
        'cookie settings',
      ];

      const captchaSelectors = [
        '#captcha',
        '#captcha-form',
        '#recaptcha',
        '.g-recaptcha',
        '.h-captcha',
        '.cf-challenge-card',
        '#challenge-form',
        '#cf-challenge-running',
        '[data-sitekey]',
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        'iframe[src*="turnstile"]',
        'iframe[src*="challenges.cloudflare.com"]',
      ];

      const captchaPhrases = [
        'please verify you are human',
        'are you a robot',
        'confirm you are human',
        'complete the captcha',
        'security challenge',
        'press and hold',
        'checking if the site connection is secure',
      ];

      const missingRequired =
        Array.isArray(requiredSelectors) &&
        requiredSelectors.length > 0 &&
        requiredSelectors.every((selector) => {
          try {
            return !document.querySelector(selector);
          } catch (_err) {
            return true;
          }
        });

      const cookieHits = collectSelectors(cookieSelectors);
      const cookieTextHits = collectPhrases(cookiePhrases);
      if (cookieHits.length || cookieTextHits.length) {
        return {
          type: 'cookie',
          reason: 'Detected cookie or consent banner covering the page',
          evidence: {
            selectors: cookieHits,
            phrases: cookieTextHits,
          },
          missingRequired,
        };
      }

      const captchaHits = collectSelectors(captchaSelectors);
      const captchaTextHits = collectPhrases(captchaPhrases);
      const captchaIframeSources = Array.from(document.querySelectorAll('iframe'))
        .map((el) => el.getAttribute('src') || '')
        .filter((src) =>
          /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|cf\.tw|\/captcha/i.test(src)
        );

      const cloudflareMarkers =
        htmlText.includes('cf-browser-verification') ||
        htmlText.includes('cf-chl-widget') ||
        htmlText.includes('cf_clearance');

      if (
        captchaHits.length ||
        captchaTextHits.length ||
        captchaIframeSources.length ||
        cloudflareMarkers
      ) {
        return {
          type: 'captcha',
          reason: 'Detected CAPTCHA or human-verification challenge',
          evidence: {
            selectors: captchaHits,
            phrases: captchaTextHits,
            iframes: captchaIframeSources,
          },
          missingRequired,
        };
      }

      if (missingRequired) {
        return {
          type: 'unknown',
          reason: 'Required page content was not found after navigation',
          evidence: {
            selectors: requiredSelectors,
          },
          missingRequired: true,
        };
      }

      return null;
    }, { requiredSelectors });
  } catch (err) {
    console.warn('[browser-service] blocker detection failed', err.message);
    return null;
  }
}

app.get('/health', async (_req, res) => {
  const isReady = Boolean(sharedPage && !sharedPage.isClosed());
  res.json({ ok: true, browserReady: isReady, queueSize: queue.size, pending: queue.pending });
});

app.post('/search', async (req, res) => {
  const {
    query,
    limit = 20,
    lang = 'en',
    waitUntil,
    waitForTimeout = 0,
    returnHtml = false,
    includeTopStories = true,
  } = req.body || {};
  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const result = await runJob(async (page) => {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(lang)}`;
      const started = Date.now();
      const response = await page.goto(searchUrl, {
        waitUntil: waitUntil || 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT,
      });
      await page.waitForSelector('#search', { timeout: NAVIGATION_TIMEOUT }).catch(() => {});
      if (waitForTimeout) {
        await page.waitForTimeout(waitForTimeout);
      }

      const blocker = await detectAccessBlocker(page, {
        requiredSelectors: ['#search .g', '#search .tF2Cxc', '#search .Gx5Zad'],
      });
      if (blocker) {
        return buildBlockerPayload(blocker, {
          timestamp: new Date().toISOString(),
          query,
          url: searchUrl,
          finalUrl: page.url(),
          status: response ? response.status() : null,
        });
      }

      const results = await page.evaluate(
        ({ maxResults }) => {
          const snippetSelectors = [
            '.VwiC3b',
            '.yXK7lf',
            '.MUxGbd span',
            '.st',
            '.IZ6rdc span',
            '[data-sncf="1"] span',
            '[data-sncf] span',
            '.NeXo2d',
            '.BNeawe span',
            '.P7MfOc',
            '.lyLwlc',
            '.NJo7tc',
            '.s3v9rd',
            '.GI74Re',
            '.HGKmee',
            '.uGCjwf',
            '.k4DMHe',
            '.V2vBId',
            '.p1CInd span',
            '.wFGQsf span',
            'div[data-content-feature="1"]',
          ];
          const siteSelectors = [
            '.tjvcx',
            '.TbwUpd',
            '.UPmit',
            '.iUh30',
            '.qLRx3b',
            '.GvPZzd',
            '.dk9qI',
            '.B0Okf.hcFEHe',
            'cite',
          ];
          const clean = (value) =>
            (value || '')
              .replace(/\s+/g, ' ')
              .replace(/\s?\u00b7\s?Translate this page/gi, '')
              .trim();
          const normalizeLines = (text) =>
            (text || '')
              .split('\n')
              .map((line) => clean(line))
              .filter(Boolean);
          const pickLineSnippet = (lines, title, host) => {
            if (!lines || !lines.length) return null;
            const filtered = lines.filter((line) => {
              const lower = line.toLowerCase();
              if (!line) return false;
              if (title && line === title.trim()) return false;
              if (host && lower.includes(host.toLowerCase())) return false;
              if (lower.startsWith('https://') || lower.startsWith('http://')) return false;
              if (line.includes('›')) return false;
              if (/^[\d.,]+\+?\s*(views?|seguidores?|followers?|comentarios?)/i.test(line)) return false;
              if (/^\d+[:.]\d{2}/.test(line)) return false;
              if (/^(translate this page|cached|string)/i.test(line)) return false;
              return true;
            });
            if (!filtered.length) return null;
            return filtered.join(' ').trim();
          };
          const isVideoResult = (node) => {
            if (!node) return false;
            if (node.classList.contains('PmEWq') || node.classList.contains('ULSxyf')) {
              return true;
            }
            if (
              node.querySelector(
                '.gY2b2c, .Woharf, .ct3k2c, .cMjHbj, [data-vidref], [data-lpage*="video"], [data-playable-url]'
              )
            ) {
              return true;
            }
            const carouselHost = node.closest('.mnr-c.g-blk, .cMjHbj, .ULSxyf');
            if (carouselHost && carouselHost.querySelector('.gY2b2c')) {
              return true;
            }
            const anchor = node.querySelector('a[href]');
            if (anchor) {
              const label = (anchor.getAttribute('aria-label') || '').toLowerCase();
              try {
                const host = new URL(anchor.href).hostname.replace(/^www\./, '');
                if (
                  (label.includes('video') || label.includes('play') || label.includes('watch')) &&
                  /(youtube\.com|youtu\.be|tiktok\.com|facebook\.com|dailymotion\.com)/.test(host)
                ) {
                  return true;
                }
              } catch (err) {
                // ignore URL parse issues
              }
            }
            return false;
          };
          const getSnippet = (root) => {
            if (!root) return null;
            for (const selector of snippetSelectors) {
              const node = root.querySelector(selector);
              if (node) {
                const text = clean(node.innerText);
                if (text) {
                  return text;
                }
              }
            }
            const attrSnippet = root.getAttribute && root.getAttribute('data-snippet');
            if (attrSnippet) {
              const text = clean(attrSnippet);
              if (text) return text;
            }
            return null;
          };

          const rawCards = Array.from(
            document.querySelectorAll(
              '#search .g, #search .tF2Cxc, #search .Gx5Zad, #search .kvH3mc, #search .Ww4FFb, #search .hlcw0c'
            )
          );
          const cards = [];
          const seenNodes = new Set();
          for (const node of rawCards) {
            const wrapper =
              (node.classList && node.classList.contains('g'))
                ? node
                : node.closest('.g, .tF2Cxc, .Gx5Zad, .Ww4FFb, .hlcw0c') || node;
            if (!wrapper || seenNodes.has(wrapper)) continue;
            seenNodes.add(wrapper);
            cards.push(wrapper);
          }

          const seenLinks = new Set();
          const items = [];
          for (const card of cards) {
            const h3 = card.querySelector('h3');
            const linkEl = card.querySelector('a[href]');
            if (!h3 || !linkEl || !linkEl.href) continue;
            if (seenLinks.has(linkEl.href)) continue;
            if (isVideoResult(card)) continue;
            seenLinks.add(linkEl.href);

            const snippetScopes = [
              card.querySelector('.IsZvec'),
              card.querySelector('.yDYNvb'),
              card.querySelector('.hlcw0c'),
              card.querySelector('.Uroaid'),
              card.querySelector('.kCrYT'),
              card.querySelector('.VwiC3b'),
              card.closest('.hlcw0c'),
              card.parentElement,
              card.nextElementSibling,
              card,
            ].filter(Boolean);

            let snippet = null;
            for (const scope of snippetScopes) {
              snippet = getSnippet(scope);
              if (snippet) break;
            }

            if (!snippet) {
              let host = null;
              try {
                host = new URL(linkEl.href).hostname.replace(/^www\./, '');
              } catch (err) {
                host = null;
              }
              const fallbackScope = card.querySelector('.IsZvec, .yDYNvb, .hlcw0c, .Uroaid') || card;
              const containers = [fallbackScope, card].filter(Boolean);
              let fallbackText = null;
              for (const container of containers) {
                const candidate = pickLineSnippet(normalizeLines(container.innerText), h3.innerText, host);
                if (candidate) {
                  fallbackText = candidate;
                  break;
                }
              }
              if (!snippet && fallbackText) {
                snippet = fallbackText;
              }
              if (!snippet) {
                snippet = pickLineSnippet(normalizeLines(card.innerText), h3.innerText, host);
              }
            }

            let sitePath = null;
            for (const selector of siteSelectors) {
              const siteNode = card.querySelector(selector);
              if (siteNode) {
                const text = clean(siteNode.innerText);
                if (text) {
                  sitePath = text;
                  break;
                }
              }
            }

            items.push({
              title: h3.innerText.trim(),
              link: linkEl.href,
              snippet,
              sitePath,
            });
            if (items.length >= maxResults) break;
          }
          return items;
        },
        { maxResults: limit }
      );
      await fillMissingSnippets(results);

      const topStories = includeTopStories
        ? await page.evaluate(() => {
            const container = document.querySelector('[aria-label="Top stories"]');
            if (!container) return null;
            const stories = Array.from(container.querySelectorAll('article, g-card, .SoaBEf')).map((story) => {
              const headline = story.querySelector('h3, h4');
              const link = story.querySelector('a');
              const source = story.querySelector('.CEMjEf, .X5OiLe, .MbEPDb');
              const time = story.querySelector('time');
              return {
                title: headline ? headline.innerText.trim() : null,
                link: link ? link.href : null,
                source: source ? source.innerText.trim() : null,
                published: time ? time.getAttribute('datetime') || time.innerText.trim() : null,
              };
            });
            return stories.filter((item) => item.title || item.link);
          })
        : null;

      const html = returnHtml ? await page.content() : undefined;
      const aiOverview = await page.evaluate(() => {
        const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const rootSelectors = [
          '#m-x-content',
          '[data-attrid="wa:/gdu/ai_overview"]',
          '[data-attrid="kc:/ai_overview"]',
          '[data-immr="ai_mod"]',
          '.D5ad8b',
          '.h7Tj7e',
        ];
        let root = null;
        for (const selector of rootSelectors) {
          const candidate = document.querySelector(selector);
          if (candidate) {
            root = candidate;
            break;
          }
        }
        if (!root) {
          const labelled = Array.from(document.querySelectorAll('[aria-label]')).find((el) =>
            (el.getAttribute('aria-label') || '').toLowerCase().includes('ai overview')
          );
          if (labelled) {
            root =
              labelled.querySelector('#m-x-content') ||
              labelled.closest('.D5ad8b, .YNk70c, .zQTmif') ||
              labelled;
          }
        }
        if (!root) return null;

        const summaryNode =
          root.querySelector('.s7d4ef, .X6JNf, .MUxGbd, .oUAP2d, .hgKElc, .z0yqbd, .g8Z8H, .N774kf') || root;
        const summary = clean(summaryNode.innerText);
        const bullets = Array.from(root.querySelectorAll('ol li, ul li'))
          .map((li) => clean(li.innerText))
          .filter(Boolean)
          .slice(0, 6);
        const citations = Array.from(root.querySelectorAll('a[href^="http"], a[data-url^="http"]'))
          .map((link) => {
            const href = link.href || link.getAttribute('data-url');
            const title = clean(link.innerText) || link.getAttribute('aria-label') || href;
            return { title, href };
          })
          .filter((item) => item.href)
          .filter(
            (item, idx, arr) =>
              arr.findIndex((entry) => entry.href === item.href) === idx
          )
          .slice(0, 5);

        if (!summary && !bullets.length && !citations.length) {
          return null;
        }

        return {
          summary,
          bullets: bullets.length ? bullets : null,
          citations,
        };
      });

      return {
        timestamp: new Date().toISOString(),
        query,
        url: searchUrl,
        finalUrl: page.url(),
        status: response ? response.status() : null,
        duration: Date.now() - started,
        results,
        topStories: topStories && topStories.length ? topStories : null,
        aiOverview,
        html,
      };
    });

    if (result && result.blocked) {
      return res.status(409).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

app.post('/maps', async (req, res) => {
  const {
    query,
    limit = 20,
    lang = 'en',
    waitUntil,
    waitForTimeout = 3000,
    scroll = true,
    returnHtml = false,
  } = req.body || {};

  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const result = await runJob(async (page) => {
      const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=${encodeURIComponent(lang)}`;
      const started = Date.now();
      const response = await page.goto(mapsUrl, {
        waitUntil: waitUntil || 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT,
      });

      await page.waitForSelector('a.hfpxzc', { timeout: NAVIGATION_TIMEOUT }).catch(() => {});
      if (waitForTimeout) {
        await page.waitForTimeout(waitForTimeout);
      }

      const blocker = await detectAccessBlocker(page, {
        requiredSelectors: ['a.hfpxzc[href*="/place/"]', '.Nv2PK', '.lMbq3e'],
      });
      if (blocker) {
        return buildBlockerPayload(blocker, {
          timestamp: new Date().toISOString(),
          query,
          url: mapsUrl,
          finalUrl: page.url(),
          status: response ? response.status() : null,
        });
      }

      const results = await page.evaluate(
        async ({ maxResults, enableScroll }) => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const collected = new Map();

          const scrape = () => {
            const cards = Array.from(document.querySelectorAll('a.hfpxzc[href*="/place/"]'));
            for (const card of cards) {
              const title = card.getAttribute('aria-label') || null;
              const href = card.href || null;
              if (!href || !title) continue;
              if (collected.has(href)) continue;
              const ratingEl = card.querySelector('.MW4etd');
              const reviewsEl = card.querySelector('.UY7F9');
              const descriptor = card.querySelector('.W4Efsd') || card.querySelector('.W4Efsd span');
              collected.set(href, {
                title,
                href,
                rating: ratingEl ? ratingEl.innerText : null,
                reviews: reviewsEl ? reviewsEl.innerText : null,
                descriptor: descriptor ? descriptor.innerText : null,
              });
            }
          };

          const panel = document.querySelector('.m6QErb.DxyBCb') || document.querySelector('.m6QErb');
          let iterations = 0;
          while (collected.size < maxResults && enableScroll && panel && iterations < 20) {
            scrape();
            panel.scrollBy(0, panel.clientHeight);
            await sleep(600);
            iterations += 1;
          }

          scrape();
          return Array.from(collected.values()).slice(0, maxResults);
        },
        { maxResults: limit, enableScroll: scroll }
      );

      const html = returnHtml ? await page.content() : undefined;
      return {
        timestamp: new Date().toISOString(),
        query,
        url: mapsUrl,
        finalUrl: page.url(),
        status: response ? response.status() : null,
        duration: Date.now() - started,
        results,
        html,
      };
    });

    if (result && result.blocked) {
      return res.status(409).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('Maps error:', error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

app.post('/fetch', async (req, res) => {
  const {
    url,
    waitUntil = DEFAULT_WAIT_UNTIL,
    waitForSelector,
    waitForSelectorTimeout,
    waitForTimeout = 0,
    returnHtml = true,
    extract,
    headers,
    evaluateScript,
    evaluateArgs,
    requiredSelectors = [],
  } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    const result = await runJob(async (page) => {
      const extraHeaders =
        headers && typeof headers === 'object' ? headers : {};
      await page.setExtraHTTPHeaders(extraHeaders);

      try {
        await page.bringToFront();
      } catch (err) {
        console.warn('[browser-service] bringToFront failed', err.message);
      }

      const started = Date.now();
      const response = await page.goto(url, { waitUntil, timeout: NAVIGATION_TIMEOUT });

      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, {
          timeout: waitForSelectorTimeout || NAVIGATION_TIMEOUT,
        });
      }

      if (waitForTimeout) {
        await page.waitForTimeout(waitForTimeout);
      }

      const blocker = await detectAccessBlocker(page, {
        requiredSelectors: Array.isArray(requiredSelectors) ? requiredSelectors : [],
      });
      if (blocker) {
        return buildBlockerPayload(blocker, {
          timestamp: new Date().toISOString(),
          url,
          finalUrl: page.url(),
          status: response ? response.status() : null,
        });
      }

      let extracted = null;
      if (Array.isArray(extract) && extract.length > 0) {
        extracted = await page.evaluate((items) => {
          const data = {};
          items.forEach(({ name, selector, attr = 'innerText' }) => {
            const node = document.querySelector(selector);
            if (!node) {
              data[name] = null;
              return;
            }
            data[name] = attr === 'innerText' ? node.innerText : node.getAttribute(attr);
          });
          return data;
        }, extract);
      }

      const html = returnHtml ? await page.content() : undefined;

      let evaluated = null;
      if (evaluateScript) {
        evaluated = await page.evaluate(
          ({ script, args }) => {
            const fn = eval(script);
            if (typeof fn === 'function') {
              return fn(args || {});
            }
            return fn;
          },
          { script: evaluateScript, args: evaluateArgs || {} }
        );
      }

      const duration = Date.now() - started;

      return {
        timestamp: new Date().toISOString(),
        url,
        finalUrl: page.url(),
        status: response ? response.status() : null,
        duration,
        extracted,
        evaluated,
        html,
      };
    });

    if (result && result.blocked) {
      return res.status(409).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: error.message || 'Unknown error' });
  }
});

app.post('/reset', async (_req, res) => {
  try {
    if (sharedPage && !sharedPage.isClosed()) {
      await sharedPage.close().catch(() => {});
    }
    sharedPage = undefined;
    if (context && !context.isClosed()) {
      await context.close();
    }
    context = undefined;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[browser-service] listening on port ${PORT}`);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  server.close();
  if (context && !context.isClosed()) {
    await context.close();
  }
  process.exit(0);
});
