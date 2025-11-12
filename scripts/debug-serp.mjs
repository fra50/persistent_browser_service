import { chromium } from "playwright";
import fs from "fs";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/debug-serp.mjs <html-file>");
  process.exit(1);
}

const html = fs.readFileSync(filePath, "utf8");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html);

const data = await page.evaluate(() => {
  const snippetSelectors = [
    ".VwiC3b",
    ".yXK7lf",
    ".MUxGbd span",
    ".st",
    ".IZ6rdc span",
    "[data-sncf=\"1\"] span",
    "[data-sncf] span",
    ".NeXo2d",
    ".BNeawe span",
    ".P7MfOc",
    ".lyLwlc",
    ".NJo7tc",
    ".s3v9rd",
    ".GI74Re",
    ".HGKmee",
    ".uGCjwf",
    ".k4DMHe",
    ".V2vBId",
    ".p1CInd span",
    ".wFGQsf span",
    "div[data-content-feature=\"1\"]",
  ];

  const clean = (text) =>
    (text || "")
      .replace(/\s+/g, " ")
      .replace(/\s?\u00b7\s?Translate this page/gi, "")
      .trim();

  const getSnippet = (node) => {
    if (!node) return null;
    for (const sel of snippetSelectors) {
      const el = node.querySelector(sel);
      if (el) {
        const text = clean(el.innerText);
        if (text) {
          return text;
        }
      }
    }
    const attrSnippet = node.getAttribute("data-snippet");
    if (attrSnippet) {
      const text = clean(attrSnippet);
      if (text) return text;
    }
    return null;
  };

  const rawCards = Array.from(
    document.querySelectorAll(
      "#search .g, #search .tF2Cxc, #search .Gx5Zad, #search .kvH3mc, #search .Ww4FFb, #search .hlcw0c"
    )
  );
  const cards = [];
  const seenNodes = new Set();
  for (const node of rawCards) {
    const wrapper = node.classList.contains("g")
      ? node
      : node.closest(".g, .tF2Cxc, .hlcw0c, .Gx5Zad, .Ww4FFb") || node;
    if (!wrapper || seenNodes.has(wrapper)) continue;
    seenNodes.add(wrapper);
    cards.push(wrapper);
  }
  return cards
    .map((card, idx) => {
      const title = card.querySelector("h3")?.innerText.trim() || null;
      const link = card.querySelector("a")?.href || null;
      if (!title || !link) return null;
      const snippetScopes = [
        card.querySelector(".IsZvec"),
        card.querySelector(".yDYNvb"),
        card.querySelector(".hlcw0c"),
        card.querySelector(".Uroaid"),
        card.querySelector(".kCrYT"),
        card.querySelector(".rGhul"),
        card.querySelector(".yDYNvb + div"),
        card,
        card.nextElementSibling,
        card.parentElement,
      ].filter(Boolean);
      let snippet = null;
      const hits = [];
      for (const scope of snippetScopes) {
        const text = getSnippet(scope);
        if (text) {
          snippet = text;
          hits.push(scope.className || scope.tagName);
          break;
        }
      }
      if (!snippet) {
        const fallbackScope =
          card.querySelector(".IsZvec") ||
          card.querySelector(".yDYNvb") ||
          card;
        const lines = fallbackScope
          ? fallbackScope.innerText
              .split("\n")
              .map((line) => clean(line))
              .filter(Boolean)
          : [];
        const domain = (() => {
          try {
            return new URL(link).hostname.replace(/^www\\./, "");
          } catch (e) {
            return null;
          }
        })();
        snippet =
          lines.find(
            (line) =>
              line.length > 25 &&
              line !== title &&
              (domain ? !line.includes(domain) : true)
          ) || null;
      }
      const textBlock = card.innerText.trim().slice(0, 280);
      const html = card.innerHTML;
      const siblingHtml = card.nextElementSibling
        ? card.nextElementSibling.outerHTML
        : null;
      const parentHtml = card.parentElement ? card.parentElement.outerHTML : null;
      const classList = card.className;
      return { idx, title, link, snippet, classList, hits, textBlock, html, siblingHtml, parentHtml };
    })
    .filter(Boolean);
});

await browser.close();
console.log(JSON.stringify(data, null, 2));
