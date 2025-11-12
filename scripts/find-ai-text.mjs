import { chromium } from "playwright";
import fs from "fs";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/find-ai-text.mjs <html-file>");
  process.exit(1);
}

const html = fs.readFileSync(filePath, "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html);
const matches = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('*'))
    .filter((el) => el.innerText && el.innerText.toLowerCase().includes('ai overview'))
    .map((el) => ({
      tag: el.tagName,
      classes: el.className,
      text: el.innerText.trim().slice(0, 200),
      ariaLabel: el.getAttribute('aria-label') || null,
      dataAttrid: el.getAttribute('data-attrid') || null,
      id: el.id || null,
      role: el.getAttribute('role') || null,
    }));
});

console.log(JSON.stringify(matches, null, 2));
await browser.close();
