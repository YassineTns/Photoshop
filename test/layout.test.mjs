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
 * And the fix for *that* broke it a third way: giving #app a definite height made
 * its flex children shrinkable, so every section was squeezed and its rows
 * clipped, with the native inputs floating loose because UXP paints them in a
 * layer that ignores the clip. Chromium hides this bug entirely - CSS gives flex
 * items an automatic minimum size so they refuse to shrink below their content,
 * and UXP does not implement that. So this test runs a second pass with that
 * automatic minimum removed, emulating the divergence, and asserts nothing
 * clips. Without `flex-shrink: 0` in the stylesheet, that pass fails.
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
  const out = {
    overlaps: [],
    overflows: [],
    collisions: [],
    zeroWidth: [],
    clipped: [],
    escaped: [],
    scroll: null,
  };
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

  // Nothing may be clipped by its own box. This is the failure that squeezed
  // flex children produce, and it is invisible to an overlap check because the
  // rows are hidden rather than displaced.
  [".section", ".section-body", ".ctl"].forEach((sel) => {
    document.querySelectorAll(sel).forEach((e) => {
      if (e.scrollHeight > e.clientHeight + 1) {
        out.clipped.push(sel + " " + (e.textContent || "").trim().slice(0, 18));
      }
    });
  });

  // And every row must sit inside the section body that owns it.
  document.querySelectorAll(".section-body").forEach((body) => {
    const b = body.getBoundingClientRect();
    if (b.height < 1) return;
    [...body.children].forEach((row) => {
      const r = row.getBoundingClientRect();
      if (r.height < 1) return;
      if (r.top < b.top - 1 || r.bottom > b.bottom + 1) {
        out.escaped.push((row.textContent || "").trim().slice(0, 18));
      }
    });
  });

  // A control that renders no options is worse than a misaligned one: it is
  // simply absent. The Shape row shipped blank this way.
  document.querySelectorAll(".section-body > div").forEach((wrap) => {
    const label = wrap.querySelector(":scope > .ctl-label");
    if (!label || wrap.className) return; // only the bare chip wrappers
    if (!wrap.querySelector(".chip-row")) return;
    if (!wrap.querySelector(".algo-chip")) out.zeroWidth.push("empty chips: " + label.textContent);
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

      // Pass 1: as a browser lays it out.
      let r = await page.evaluate(PROBE);
      let tag = `${width}px ${mode} ${scheme}`;
      ok(pageErrors.length === 0, `${tag}: the panel starts with no errors${fmt(pageErrors)}`);
      assertGeometry(r, tag);

      // Pass 2: with the automatic minimum size of flex items removed, which is
      // how UXP behaves. Anything relying on a browser refusing to shrink a flex
      // item below its content collapses here.
      await page.addStyleTag({
        content:
          "#app > *, .sections, .section, .section-body, .ctl, .toolbar, .preset-bar" +
          " { min-height: 0 !important; }",
      });
      await page.waitForTimeout(150);
      r = await page.evaluate(PROBE);
      tag = `${width}px ${mode} ${scheme} [uxp flex]`;
      assertGeometry(r, tag);
      await page.close();
    }
  }
}

await browser.close();

function assertGeometry(r, tag) {
  ok(r.overlaps.length === 0, `${tag}: no sibling overlap${fmt(r.overlaps)}`);
  ok(r.collisions.length === 0, `${tag}: no stacked-row collision${fmt(r.collisions)}`);
  ok(r.overflows.length === 0, `${tag}: nothing overflows the panel${fmt(r.overflows)}`);
  ok(r.zeroWidth.length === 0, `${tag}: nothing collapsed to zero${fmt(r.zeroWidth)}`);
  ok(r.clipped.length === 0, `${tag}: nothing is clipped by its own box${fmt(r.clipped)}`);
  ok(r.escaped.length === 0, `${tag}: every row stays inside its section${fmt(r.escaped)}`);
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
}

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

