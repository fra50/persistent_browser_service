import { chromium } from "playwright";
import fs from "fs";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/debug-ai.mjs <html-file>");
  process.exit(1);
}

const html = fs.readFileSync(filePath, "utf8");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html);

const data = await page.evaluate(() => {
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
  const citations = Array.from(root.querySelectorAll('a[href^="http"], a[data-url^="http"]')).map((link) => {
    const href = link.href || link.getAttribute('data-url');
    const title = clean(link.innerText) || link.getAttribute('aria-label') || href;
    return { title, href, classes: link.className };
  });

  return {
    tag: root.tagName,
    classes: root.className,
    summary,
    bullets,
    html: root.innerHTML,
    citations,
  };
});

console.log(JSON.stringify(data, null, 2));
await browser.close();
