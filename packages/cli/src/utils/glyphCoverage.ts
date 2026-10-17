import { create, type Font } from "fontkit";
import type { Page } from "puppeteer-core";

export interface RawFontFace {
  family: string;
  src: string;
  base: string;
}

export interface StyledText {
  fontFamily: string;
  textTransform: string;
  text: string;
}

export interface FamilyFaces {
  /** Authored spelling, for the message. */
  family: string;
  /** One entry per face; null when the face has no fetchable `url()`. */
  urls: Array<string | null>;
}

const MAX_LISTED = 40;
const NOT_FROM_A_TEXT_FACE = /[\p{White_Space}\p{Cc}\p{Cf}\p{Emoji_Presentation}\u{FE0E}\u{FE0F}]/u;

/** Runs in the page: every `@font-face` rule, through `@import`, `@media` and `@supports`. */
function collectFontFaces(): RawFontFace[] {
  const faces: RawFontFace[] = [];
  const sheets = Array.from(document.styleSheets);
  for (let i = 0; i < sheets.length; i += 1) {
    const sheet = sheets[i]!;
    let rules: CSSRule[];
    try {
      rules = Array.from(sheet.cssRules);
    } catch {
      continue; // A cross-origin sheet hides its rules.
    }
    const base = sheet.href ?? document.baseURI;
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) {
        const style = rule.style;
        faces.push({
          family: style.getPropertyValue("font-family"),
          src: style.getPropertyValue("src"),
          base,
        });
      } else if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) sheets.push(rule.styleSheet);
      } else if ("cssRules" in rule) {
        rules.push(...Array.from((rule as CSSGroupingRule).cssRules));
      }
    }
  }
  return faces;
}

/** Runs in the page: each rendered text node with the computed style that picks its face. */
function collectStyledText(): StyledText[] {
  const texts: StyledText[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/i.test(parent.tagName)) continue;
    const { fontFamily, textTransform } = getComputedStyle(parent);
    texts.push({ fontFamily, textTransform, text: node.textContent ?? "" });
  }
  return texts;
}

function unquoted(raw: string): string {
  return raw.trim().replace(/^(['"])(.*)\1$/, "$2");
}

function familyKey(raw: string): string {
  return unquoted(raw).toLowerCase();
}

export function faceUrl(src: string, base: string): string | null {
  const url = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(src)?.[2];
  return url ? new URL(url, base).href : null;
}

export function facesByFamily(faces: RawFontFace[]): Map<string, FamilyFaces> {
  const families = new Map<string, FamilyFaces>();
  for (const face of faces) {
    const key = familyKey(face.family);
    const entry = families.get(key) ?? { family: unquoted(face.family), urls: [] };
    entry.urls.push(faceUrl(face.src, face.base));
    families.set(key, entry);
  }
  return families;
}

export function renderedText({ text, textTransform }: StyledText): string {
  if (textTransform === "uppercase") return text.toUpperCase();
  if (textTransform === "lowercase") return text.toLowerCase();
  if (textTransform === "capitalize") return text + text.toUpperCase();
  return text;
}

/** The characters each declared family is asked to draw: the first family of the stack wins. */
export function charsByFamily(
  texts: StyledText[],
  declared: Set<string>,
): Map<string, Set<string>> {
  const chars = new Map<string, Set<string>>();
  for (const styled of texts) {
    const key = familyKey(styled.fontFamily.split(",")[0] ?? "");
    if (!declared.has(key)) continue;
    const set = chars.get(key) ?? new Set<string>();
    for (const ch of renderedText(styled)) if (!NOT_FROM_A_TEXT_FACE.test(ch)) set.add(ch);
    chars.set(key, set);
  }
  return chars;
}

function fontsOf(bytes: Uint8Array): Font[] {
  const font = create(Buffer.from(bytes));
  return "fonts" in font ? font.fonts : [font];
}

/**
 * Characters of `chars` that no face has a glyph for, or null when a face cannot be
 * read (a `local()` face, an unparseable file): coverage is then unknown, not missing.
 */
export function missingGlyphs(
  faces: Array<Uint8Array | null>,
  chars: Iterable<string>,
): string[] | null {
  let fonts: Font[];
  try {
    if (faces.length === 0 || faces.includes(null)) return null;
    fonts = faces.flatMap((face) => fontsOf(face!));
  } catch {
    return null;
  }
  return [...chars].filter(
    (ch) => !fonts.some((font) => font.hasGlyphForCodePoint(ch.codePointAt(0)!)),
  );
}

export function glyphCoverageMessage(family: string, missing: string[]): string {
  const listed = missing.slice(0, MAX_LISTED).join(" ");
  const more = missing.length > MAX_LISTED ? ` …and ${missing.length - MAX_LISTED} more` : "";
  return (
    `@font-face "${family}" has no glyph for ${missing.length} character(s) in its text: ${listed}${more}. ` +
    "They render in a fallback font. Use a font file that covers them, or add a face for them to the family."
  );
}

async function fetchFace(url: string | null): Promise<Uint8Array | null> {
  if (!url) return null;
  try {
    const response = await fetch(url);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function glyphCoverageMessages(faces: RawFontFace[], texts: StyledText[]): Promise<string[]> {
  const families = facesByFamily(faces);
  const messages: string[] = [];
  for (const [key, chars] of charsByFamily(texts, new Set(families.keys()))) {
    const { family, urls } = families.get(key)!;
    const missing = missingGlyphs(await Promise.all(urls.map(fetchFace)), chars);
    if (missing && missing.length > 0) messages.push(glyphCoverageMessage(family, missing));
  }
  return messages;
}

/** `font_missing_glyphs` warnings for the settled page. A probe failure is not a finding. */
export async function auditGlyphCoverage(page: Page): Promise<string[]> {
  try {
    const faces = await page.evaluate(collectFontFaces);
    return await glyphCoverageMessages(faces, await page.evaluate(collectStyledText));
  } catch {
    return [];
  }
}
