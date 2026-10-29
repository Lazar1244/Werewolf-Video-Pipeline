/**
 * Deterministic text utilities (ARCHITECTURE.md §5.5, ruleset §14.4 and §14.6).
 * Both algorithms are part of the engine version: changing them changes replays.
 *
 * Note: non-printing characters in this file are written as escape sequences
 * (enforced by tests/architecture.test.ts).
 */

/** A word = letters/digits, optionally joined by an apostrophe or hyphen. */
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  return text.match(WORD_RE)?.length ?? 0;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  words: number;
}

/** Keep text up to the end of word `limit`; append an ellipsis when cut. */
export function truncateWords(text: string, limit: number): TruncateResult {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`limit must be an integer >= 0 (got ${limit})`);
  let n = 0;
  let end = 0;
  for (const m of text.matchAll(WORD_RE)) {
    n++;
    if (n === limit) end = (m.index ?? 0) + m[0].length;
    if (n > limit) {
      return { text: text.slice(0, end).trimEnd() + '…', truncated: true, words: limit };
    }
  }
  return { text, truncated: false, words: n };
}

/** Reserved engine delimiters; never allowed in player text. */
export const ENGINE_OPEN = '⟦ENGINE⟧';
export const ENGINE_CLOSE = '⟦/ENGINE⟧';

/** Look-alikes of the reserved delimiters, removed outright: U+27E6/7 and U+301A/B. */
const DELIMITER_LOOKALIKES_RE = /[⟦⟧〚〛]/gu;

/**
 * Bracket look-alikes folded to ASCII before tag detection
 * (NFKC already folds the fullwidth forms of [ ] < >).
 */
const BRACKET_FOLD: Record<string, string> = {
  '【': '[', '】': ']',
  '〔': '[', '〕': ']',
  '〖': '[', '〗': ']',
  '〘': '[', '〙': ']',
  '⟪': '[', '⟫': ']',
  '⦅': '[', '⦆': ']',
  '⦃': '[', '⦄': ']',
  '〈': '<', '〉': '>',
  '〈': '<', '〉': '>',
  '⟨': '<', '⟩': '>',
  '‹': '<', '›': '>',
};
const BRACKET_FOLD_RE = new RegExp(`[${Object.keys(BRACKET_FOLD).join('')}]`, 'gu');

/**
 * Authority words a player could use to impersonate the game. Deliberately
 * narrow to avoid stripping normal speech ("[host]", "tool", "gm" stay).
 * Known accepted trade-off: "[Narrator]" or a line starting "Engine:" is stripped too.
 */
const SPOOF_WORDS = 'system|engine|admin|administrator|assistant|developer|narrator|moderator|game[ \\t_-]*master';
/**
 * End of an authority word: optional "_suffix" (SYSTEM_PROMPT) or trailing digits (SYSTEM2),
 * then no further letter/digit — so "[Systemic]" and "SYSTEM2FA" are not treated as tags.
 */
const WORD_END = `(?:_[\\p{L}\\p{N}_]*|\\d+)?(?![\\p{L}\\p{N}])`;
/** Max body length of a bracketed spoof tag removed as a whole; longer/unclosed tags lose their head only. */
const TAG_BODY_MAX = 300;
/** [SYSTEM], [ system: long text … ], [/engine], or an unclosed "[SYSTEM …" head. */
const BRACKET_TAG_RE = new RegExp(`\\[[ \\t]*\\/?[ \\t]*(?:${SPOOF_WORDS})${WORD_END}(?:[^\\]\\n]{0,${TAG_BODY_MAX}}\\])?(?:[ \\t]*:)?`, 'giu');
/**
 * <system>, </engine>, <admin note=…>, <system tray> — the word must follow "<" directly,
 * so text like "a < system tray > b" (space after "<") is kept.
 */
const ANGLE_TAG_RE = new RegExp(`<(?:\\/[ \\t]*)?(?:${SPOOF_WORDS})${WORD_END}(?:[^>\\n]{0,${TAG_BODY_MAX}}>)?`, 'giu');
/** Chat-template control tokens (<|im_start|>, <|system|> …) plus a directly following role word. */
const CHAT_TOKEN_RE =
  /<\|[^|>\n]{0,40}\|>(?:[ \t]*(?:system|assistant|user|developer|tool)\b)?|\[\/?INST\]|<<\/?SYS>>/giu;
/**
 * Decoration that may precede a role word on a line: markdown, quotes (incl. curly), bullets,
 * dashes, arrows, "=>", emoji (with VS16 / skin tones / ZWJ). Unbounded but matched
 * atomically (lookahead capture + back-reference), so it never backtracks and stays linear.
 */
const LEAD_CLASS = `[ \\t>*_~(={/|@\\-+"'\`#•–—→⇒»«“”‘’「」\\p{Extended_Pictographic}\\uFE0F\\p{Emoji_Modifier}\\u200D]`;
/** Atomic run of lead characters using capture group n. */
const atomicLead = (n: number) => `(?=(${LEAD_CLASS}*))\\${n}`;
/**
 * List markers: 1. 2) (3) a. i) iv. #1 [ ] [x] ("#" is part of the lead run). The alternatives never overlap (roman numerals need 2+
 * letters) and the lead run after a marker already covers spaces, so repeated markers
 * ("1. 1. 1. …") cannot backtrack exponentially.
 */
const LIST_MARK = `(?:\\(?(?:\\d{1,3}|[ivx]{2,4}|[a-z])[.)]|\\d{1,3}(?![.\\d)])|\\[[ xX]?\\])`;
/** Up to six extra words and an optional (qualifier) / [qualifier]: "SYSTEM NOTICE (automated):". */
const ROLE_QUALIFIER = `(?:[ \\t]+\\p{L}{1,20}){0,6}(?:[ \\t]*[(\\[][^)\\]\\n]{0,30}[)\\]])?`;
const ONE_ROLE_PREFIX =
  `${atomicLead(1)}(?:${LIST_MARK}${atomicLead(2)})*(?:${SPOOF_WORDS})${WORD_END}${ROLE_QUALIFIER}["'\`)}|”’」]?[ \\t*_~]{0,8}:[*_~]{0,4}`;
/**
 * Role prefixes at the start of a line ("SYSTEM:", "**SYSTEM:**", ">>>>>> System:", "1. 2. SYSTEM:",
 * "(SYSTEM):", '"SYSTEM":', "=> SYSTEM:" …). A chain like "SYSTEM: ENGINE: …" goes in one match.
 */
const ROLE_PREFIX_RE = new RegExp(`^(?:${ONE_ROLE_PREFIX})+`, 'gimu');

/**
 * Remove empty bracket pairs ("[]", "[ ]", "<>") in one linear pass, nested ones included, so
 * splitting a tag with them ("SYS[]TEM:", "[[]SYSTEM]") cannot re-form a tag after the last check.
 * Runs inside the stripping loop. Accepted trade-off: literal "[ ]" / "<>" in speech disappear.
 * It never emits two spaces in a row, so the look-back over spaces is O(1).
 */
function removeEmptyPairs(s: string): string {
  if (!s.includes(']') && !s.includes('>')) return s;
  const out: string[] = [];
  for (const c of s) {
    if (c === ']' || c === '>') {
      const open = c === ']' ? '[' : '<';
      let j = out.length - 1;
      while (j >= 0 && (out[j] === ' ' || out[j] === '\t')) j--;
      if (j >= 0 && out[j] === open) {
        out.length = j;
        continue;
      }
    }
    if ((c === ' ' || c === '\t') && (out[out.length - 1] === ' ' || out[out.length - 1] === '\t')) continue;
    out.push(c);
  }
  return out.join('');
}

/**
 * Collapse runs of spaces/tabs to one space and runs of 3+ newlines to 2, so no regex or
 * the empty-pair look-back ever re-scans a long whitespace run on every pass.
 */
function collapseWhitespace(s: string): string {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^ | $/g, ''); // string edges too, so a removed prefix never leaves a leading space
}

/** After this many productive passes the input is adversarial: all tag syntax ([ ] < > |) is dropped. */
const MAX_STRIP_PASSES = 256;

/**
 * Every other whitespace character (U+1680 Ogham space, U+2000-U+200A, U+202F, U+205F,
 * U+3000 …) and U+2800 (Braille blank) becomes a plain space before tag detection, so an
 * exotic space cannot hide a line-start role prefix that a final trim would expose.
 */
const HORIZONTAL_SPACE_RE = /[^\S\n]|\u2800/gu;

/** Unicode line/paragraph separators and NEL become ordinary newlines. */
const LINE_SEPARATORS_RE = /\r\n?|[\u2028\u2029\u0085]/gu;
/**
 * Invisible characters removed: all Cc except \n and \t, all Cf (bidi controls,
 * zero-width chars, BOM, soft hyphen, tag characters) and every other
 * Default_Ignorable_Code_Point (variation selectors, combining grapheme joiner,
 * Hangul fillers …) — except ZWJ and VS16, which are handled below.
 */
const INVISIBLE_RE = /(?![\n\t\u200D\uFE0F])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const VS16 = String.fromCharCode(0xfe0f);
const KEYCAP = String.fromCharCode(0x20e3);
/** VS16 survives only right after an emoji, or inside a keycap sequence (#⃣ style: [#*0-9] + VS16 + U+20E3). */
function stripStrayVs16(s: string): string {
  if (!s.includes(VS16)) return s;
  let out = '';
  let prev = '';
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === VS16) {
      const afterEmoji = /\p{Extended_Pictographic}/u.test(prev);
      const keycap = /^[#*0-9]$/.test(prev) && chars[i + 1] === KEYCAP;
      if (!afterEmoji && !keycap) continue;
    }
    out += c;
    prev = c;
  }
  return out;
}
/** ZWJ survives only when joining two emoji (e.g. family / profession emoji sequences). */
const STRAY_ZWJ_RE = /(?<!\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

/** Default hard cap on raw input size; bounds the worst-case cost of repeated tag stripping. */
export const DEFAULT_MAX_CHARS = 16_000;

export interface SanitizeOptions {
  /** Model/provider names to mask (frozen per game). Whole-word, case-insensitive. */
  maskNames?: readonly string[];
  /** Hard character cap applied first (default DEFAULT_MAX_CHARS). Never splits a surrogate pair. */
  maxChars?: number;
}

export const MASK_TOKEN = '[redacted]';

/**
 * Clean player-authored text before it is stored in an engine event:
 * - caps the raw size (DEFAULT_MAX_CHARS unless overridden)
 * - NFKC normalisation (folds fullwidth / compatibility look-alikes; also turns an ellipsis into "...")
 * - removes invisible characters (ZWJ / VS16 kept only inside emoji sequences)
 * - removes delimiter look-alikes, spoofed authority tags, role prefixes and chat tokens, repeatedly until stable
 * - normalises whitespace, then masks model and provider names
 */
export function sanitizePlayerText(input: string, opts: SanitizeOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 0) throw new RangeError(`maxChars must be an integer >= 0 (got ${maxChars})`);
  let t = input.length > maxChars ? safeSlice(input, maxChars) : input;
  t = t.normalize('NFKC');
  t = t.replace(LINE_SEPARATORS_RE, '\n');
  t = stripStrayVs16(t.replace(INVISIBLE_RE, '')).replace(STRAY_ZWJ_RE, '');
  t = t.replace(HORIZONTAL_SPACE_RE, ' '); // after invisible removal (JS treats U+FEFF as whitespace)
  t = t.replace(BRACKET_FOLD_RE, (c) => BRACKET_FOLD[c] ?? c);
  t = collapseWhitespace(t);
  // Every productive pass makes the text strictly shorter (tabs are already spaces, so whitespace
  // collapsing never keeps the length), and each pass is linear, so this
  // terminates quickly; after MAX_STRIP_PASSES all tag syntax is dropped (adversarial input).
  for (let pass = 1; ; pass++) {
    const before = t;
    t = t
      .replace(DELIMITER_LOOKALIKES_RE, '')
      .replace(CHAT_TOKEN_RE, '')
      .replace(BRACKET_TAG_RE, '')
      .replace(ANGLE_TAG_RE, '')
      .replace(ROLE_PREFIX_RE, '');
    t = removeEmptyPairs(collapseWhitespace(t));
    if (t === before) break;
    if (pass === MAX_STRIP_PASSES) t = t.replace(/[[\]<>|]/g, '');
  }
  t = t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return maskNames(t, opts.maskNames ?? []);
}

/** Separators between the parts of a model name: whitespace, dashes, underscore, dot, middle dot, slash, minus sign. */
const NAME_SEP_CLASS = `[\\s\\p{Pd}_.·/${String.fromCharCode(0x2212)}]`;
const NAME_SEP_SPLIT_RE = new RegExp(`${NAME_SEP_CLASS}+`, 'u');
/** In the text, the separator is optional: "gpt-4o" also masks "gpt4o", "GPT.4o", "GPT−4o". */
const NAME_SEP_PATTERN = `${NAME_SEP_CLASS}*`;

/**
 * Mask names longest-first. Name parts may be joined by any run of NAME_SEP_CLASS
 * characters, or by nothing at all.
 * Both the text and the names are NFKC-normalised first.
 */
export function maskNames(text: string, names: readonly string[], replacement: string = MASK_TOKEN): string {
  const sorted = [...new Set(names.map((n) => n.normalize('NFKC').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  let t = text.normalize('NFKC');
  for (const name of sorted) {
    const parts = name.split(NAME_SEP_SPLIT_RE).filter(Boolean);
    if (parts.length === 0) continue; // a name made only of separators would match everywhere
    const body = parts.map(escapeRegExp).join(NAME_SEP_PATTERN);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
    t = t.replace(re, () => replacement);
  }
  return t;
}

/** Slice to at most `max` UTF-16 units without leaving a lone high surrogate. */
function safeSlice(s: string, max: number): string {
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Sanitise, then enforce a word limit (ruleset §14.4: over-limit text is truncated, not invalid). */
export function cleanAndLimit(input: string, wordLimit: number, opts: SanitizeOptions = {}): TruncateResult {
  return truncateWords(sanitizePlayerText(input, opts), wordLimit);
}
