import { chromium } from "playwright";

const PAIR_URL = process.argv[2];
if (!PAIR_URL) throw new Error("usage: script <pair-url>");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(PAIR_URL, { waitUntil: "load" });
await page.waitForTimeout(6000);
await page.screenshot({ path: "/tmp/t3shots/01-after-pair.png" });
console.log("URL:", page.url());
console.log("TITLE:", await page.title());
const text = await page.evaluate(() => document.body.innerText.slice(0, 2000));
console.log("TEXT:", text);
await browser.close();
