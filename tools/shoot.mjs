/**
 * Screenshot the real panel at a real panel width, for judging the look.
 *
 *   node tools/shoot.mjs [width] [scheme] [out.png]
 *
 * Not part of `npm test`: this proves nothing, it just lets a human (or an
 * agent) see what the layout test can only measure.
 */
import { chromium } from "playwright";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const width = Number(process.argv[2] || 360);
const scheme = process.argv[3] || "dark";
const out = process.argv[4] || path.join(ROOT, "panel.png");
const openAll = process.argv[5] === "open";

const EXEC = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(
  existsSync(EXEC)
    ? { executablePath: EXEC, headless: false, args: ["--headless=new", "--no-sandbox"] }
    : { args: ["--no-sandbox"] }
);
const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
await page.goto("file://" + path.join(ROOT, "panel-preview.html"));
await page.waitForTimeout(700);
if (openAll) {
  await page.evaluate(() => {
    document.querySelectorAll(".section").forEach((s) => (s.className = "section open"));
  });
  await page.waitForTimeout(200);
}
await page.screenshot({ path: out });
await browser.close();
console.log(out);
