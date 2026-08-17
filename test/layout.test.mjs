/**
 * Panel layout regression test.
 *
 *   npm run test:layout
 *
 * The panel once shipped with every control piled on top of its neighbour,
 * because the stylesheet used three things UXP does not implement: flex `gap`,
 * a fixed `height` on rows containing form controls, and a flex basis on inputs
 * (which assert their own intrinsic width and win). None of that shows up in a
 * unit test - it is only visible once the CSS is laid out.
 *
 * It then shipped again unable to scroll: a UXP panel does not scroll its
 * document for you, so every section below the fold was simply unreachable.
 *
 * So this renders the real panel at real panel widths and asserts geometry: no
 * two siblings in a row may overlap, no row may overflow, no two stacked rows
 * may collide, nothing may collapse to zero, and the panel must scroll far
 * enough to reach its own last section. It cannot prove UXP agrees with
 * Chromium, but every rule that broke was one Chromium would have caught,
 * because the fix in each case was to stop relying on a feature UXP lacks and
 * use the plainer form that both engines implement.
 *
 * Playwright is an optional dev dependency: if it is missing the test skips
 * rather than fails, so `npm test` stays dependency-free.
 */

import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
/**
 * The *real* panel: index.html's markup driven by the real panel.js against stub
 * host modules. Testing a lookalike would only prove the lookalike is fine.
 */
const PAGE = path.join(ROOT, "panel-preview.html");

/** Panel widths to check: the manifest minimum, the docked default, and wide. */
const WIDTHS = [300, 360, 420];

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("playwright not installed - skipping layout test");
  console.log("  npm i -D playwright && npx playwright install chromium");
  process.exit(0);
}

if (!existsSync(PAGE)) {
  console.log("playground.html missing - run `npm run playground` first");
  process.exit(1);
}

const EXEC = process.env.PLAYWRIGHT_CHROMIUM || "/opt/pw-browsers/chromium";
const launchOpts = existsSync(EXEC)
  ? { executablePath: EXEC, headless: false, args: ["--headless=new", "--no-sandbox"] }
  : { args: ["--no-sandbox"] };

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${msg}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`);
  }
}

/** Geometry probe, run inside the page. */
const PROBE = () => {
  const out = { overlaps: [], overflows: [], collisions: [], zeroWidth: [], scroll: null };
  const app = document.getElementById("app");
  const host = app.getBoundingClientRect();

  // Scrolling: content taller than the panel must be reachable, and the last
  // section must actually come into view when scrolled to the bottom.
  app.scrollTop = app.scrollHeight;
  const sections = [...document.querySelectorAll(".section")];
  const last = sections[sections.length - 1];
  out.scroll = {
    overflowY: getComputedStyle(app).overflowY,
    content: Math.round(app.scrollHeight),
    panel: Math.round(app.clientHeight),
    scrolled: Math.round(app.scrollTop),
    maxScroll: Math.round(app.scrollHeight - app.clientHeight),
    lastReachable: last
      ? last.getBoundingClientRect().bottom <= window.innerHeight + 2
      : false,
    sections: sections.length,
  };
  app.scrollTop = 0;

  document.querySelectorAll(".ctl").forEach((row) => {
    const label = (row.textContent || "").trim().slice(0, 24);
    const kids = [...row.children].map((c) => c.getBoundingClientRect());
    for (let i = 1; i < kids.length; i++) {
      if (kids[i].left < kids[i - 1].right - 0.5) out.overlaps.push(label);
    }
    if (row.getBoundingClientRect().right > host.right + 1) out.overflows.push(label);
  });

  // A slider squeezed to nothing is the specific failure the input width caused.
  document.querySelectorAll(".slider-track").forEach((t) => {
    const r = t.getBoundingClientRect();
    if (r.width < 20) out.zeroWidth.push("slider " + r.width.toFixed(0) + "px");
  });

  document.querySelectorAll(".section-body").forEach((body) => {
    const rows = [...body.children];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1].getBoundingClientRect();
      const b = rows[i].getBoundingClientRect();
      if (a.height > 0 && b.height > 0 && a.bottom > b.top + 0.5) {
        out.collisions.push((rows[i].textContent || "").trim().slice(0, 24));
      }
    }
  });

  [".algo-chip", ".preset-chip", ".btn", ".swatch", ".seg"].forEach((sel) => {
    document.querySelectorAll(sel).forEach((c) => {
      const r = c.getBoundingClientRect();
      if (r.right > host.right + 1) out.overflows.push(sel + " " + (c.textContent || "").trim());
      if (r.width < 4 || r.height < 4) out.zeroWidth.push(sel + " collapsed");
    });
  });

  return out;
};

const browser = await chromium.launch(launchOpts);

for (const width of WIDTHS) {
  for (const mode of ["Halftone", "Dither"]) {
    for (const scheme of ["dark", "light"]) {
      // A real panel height, not a tall one: scrolling only exists if the
      // viewport is smaller than the content.
      const page = await browser.newPage({
        viewport: { width, height: 720 },
        colorScheme: scheme,
      });
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));
      page.on("console", (m) => {
        if (m.type() === "error") pageErrors.push(m.text());
      });
      await page.goto("file://" + PAGE);
      await page.waitForTimeout(700);

      // Switch mode, expand everything, and turn on the conditional sections so
      // the controls that only appear in some states are checked too.
      await page.evaluate((m) => {
        const seg = [...document.querySelectorAll(".seg-item")];
        const target = seg.find((c) => c.textContent.trim() === m);
        if (target) target.click();
      }, mode);
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const on = (label) => {
          const rows = [...document.querySelectorAll(".ctl")];
          const row = rows.find((r) => (r.textContent || "").trim().startsWith(label));
          const t = row && row.querySelector(".toggle");
          if (t && t.className.indexOf("on") < 0) t.click();
        };
        on("Tonal zones");
        const seg = [...document.querySelectorAll(".seg-item")];
        const perInk = seg.find((c) => c.textContent.trim() === "Per Ink");
        if (perInk) perInk.click();
        const dpi = seg.find((c) => c.textContent.trim() === "Dpi");
        if (dpi) dpi.click();
      });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        document.querySelectorAll(".section").forEach((s) => (s.className = "section open"));
      });
      await page.waitForTimeout(200);

      const r = await page.evaluate(PROBE);
      const tag = `${width}px ${mode} ${scheme}`;
      ok(pageErrors.length === 0, `${tag}: the panel starts with no errors${fmt(pageErrors)}`);
      ok(r.overlaps.length === 0, `${tag}: no sibling overlap${fmt(r.overlaps)}`);
      ok(r.collisions.length === 0, `${tag}: no stacked-row collision${fmt(r.collisions)}`);
      ok(r.overflows.length === 0, `${tag}: nothing overflows the panel${fmt(r.overflows)}`);
      ok(r.zeroWidth.length === 0, `${tag}: nothing collapsed to zero${fmt(r.zeroWidth)}`);
      ok(r.scroll.sections >= 8, `${tag}: the panel built its sections (${r.scroll.sections})`);
      ok(
        r.scroll.overflowY === "auto" || r.scroll.overflowY === "scroll",
        `${tag}: the panel is a scroll container (overflow-y: ${r.scroll.overflowY})`
      );
      ok(
        r.scroll.content > r.scroll.panel,
        `${tag}: content exceeds the panel, so scrolling is the case that matters ` +
          `(${r.scroll.content}px in ${r.scroll.panel}px)`
      );
      ok(
        r.scroll.scrolled === r.scroll.maxScroll && r.scroll.maxScroll > 0,
        `${tag}: scrolls to the bottom (${r.scroll.scrolled}/${r.scroll.maxScroll})`
      );
      ok(r.scroll.lastReachable, `${tag}: the last section is reachable`);

      await page.close();
    }
  }
}

await browser.close();

function fmt(list) {
  if (!list.length) return "";
  const uniq = [...new Set(list)];
  return ` (${uniq.slice(0, 4).join("; ")}${uniq.length > 4 ? ` +${uniq.length - 4} more` : ""})`;
}

console.log("\n" + "-".repeat(60));
if (failed) {
  console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed`);
  process.exitCode = 1;
} else {
  console.log(`\x1b[32mAll ${passed} layout assertions passed.\x1b[0m`);
}

