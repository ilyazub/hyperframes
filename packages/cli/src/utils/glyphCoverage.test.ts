import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import {
  auditGlyphCoverage,
  charsByFamily,
  faceUrl,
  facesByFamily,
  glyphCoverageMessage,
  missingGlyphs,
  renderedText,
} from "./glyphCoverage.js";

// A Latin-only subset (no Cyrillic, no ©) the repo already ships.
const LATIN_ONLY = readFileSync(
  resolve(
    __dirname,
    "../../../../skills/embedded-captions/modes/standard/fonts/files/orbitron-latin-400-normal.woff2",
  ),
);
const LATIN_ONLY_URL = `data:font/woff2;base64,${LATIN_ONLY.toString("base64")}`;

describe("missingGlyphs", () => {
  it("lists the characters a Latin-only face cannot draw", () => {
    expect(missingGlyphs([LATIN_ONLY], "HelloПривіт©")).toEqual([
      "П",
      "р",
      "и",
      "в",
      "і",
      "т",
      "©",
    ]);
  });

  it("is covered when the text is Latin", () => {
    expect(missingGlyphs([LATIN_ONLY], "Hello")).toEqual([]);
  });

  it("reports unknown, not missing, when a face cannot be read", () => {
    expect(missingGlyphs([], "П")).toBeNull();
    expect(missingGlyphs([LATIN_ONLY, null], "П")).toBeNull();
    expect(missingGlyphs([Buffer.from("not a font")], "П")).toBeNull();
  });

  it("caps the listed characters", () => {
    const missing = Array.from({ length: 41 }, (_, i) => String.fromCodePoint(0x410 + i));
    const message = glyphCoverageMessage("Brand", missing);
    expect(message).toContain('@font-face "Brand" has no glyph for 41 character(s)');
    expect(message).toContain("…and 1 more");
    expect(glyphCoverageMessage("Brand", ["П"])).not.toContain("more");
  });
});

describe("font face and text inputs", () => {
  it("resolves the first url() of a face against its stylesheet, and null for local()", () => {
    expect(faceUrl(`url("fonts/a.woff2") format("woff2")`, "http://h/css/s.css")).toBe(
      "http://h/css/fonts/a.woff2",
    );
    expect(faceUrl(`local("Brand")`, "http://h/")).toBeNull();
  });

  it("groups faces by case-insensitive family and keeps the authored spelling", () => {
    const families = facesByFamily([
      { family: '"Brand"', src: "url(a.woff2)", base: "http://h/" },
      { family: "brand", src: "local(Brand)", base: "http://h/" },
    ]);
    expect([...families]).toEqual([
      ["brand", { family: "Brand", urls: ["http://h/a.woff2", null] }],
    ]);
  });

  it("applies text-transform", () => {
    const styled = (textTransform: string) => ({ fontFamily: "x", textTransform, text: "Ab" });
    expect(renderedText(styled("uppercase"))).toBe("AB");
    expect(renderedText(styled("lowercase"))).toBe("ab");
    expect(renderedText(styled("capitalize"))).toBe("AbAB");
    expect(renderedText(styled("none"))).toBe("Ab");
  });

  it("collects only the first family of each stack, without spaces, controls or emoji", () => {
    const chars = charsByFamily(
      [
        { fontFamily: '"Brand", sans-serif', textTransform: "none", text: "Пр 🙂‍" },
        { fontFamily: "sans-serif, Brand", textTransform: "none", text: "Ж" },
      ],
      new Set(["brand"]),
    );
    expect([...chars]).toEqual([["brand", new Set(["П", "р"])]]);
  });
});

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

async function auditHtml(html: string): Promise<string[]> {
  const chrome = await puppeteer.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    const page = await chrome.newPage();
    await page.setContent(html);
    return await auditGlyphCoverage(page);
  } finally {
    await chrome.close();
  }
}

describe.runIf(executablePath)("auditGlyphCoverage in Chromium", () => {
  it("flags only the text set in the declared family, after text-transform", async () => {
    const messages = await auditHtml(`<style>
      @media screen { @font-face { font-family: "Brand"; src: url(${LATIN_ONLY_URL}) format("woff2"); } }
      h1 { font-family: "Brand", sans-serif; text-transform: uppercase; }
      p { font-family: sans-serif; }
    </style>
    <h1>Hello привіт</h1><p>Ж is not in Brand's text</p><script>"Щ"</script>`);
    expect(messages).toEqual([
      expect.stringContaining('"Brand" has no glyph for 6 character(s) in its text: П Р И В І Т.'),
    ]);
  });

  it("is silent when the declared family covers its text", async () => {
    const html = `<style>@font-face { font-family: Brand; src: url(${LATIN_ONLY_URL}); }
      body { font-family: Brand; }</style><h1>Hello world 🙂</h1>`;
    expect(await auditHtml(html)).toEqual([]);
  });
});
