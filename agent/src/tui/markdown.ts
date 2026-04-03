/**
 * Markdown rendering for TUI output.
 * Uses Pi-Agent's Markdown class (marked.lexer + custom token renderer)
 * with cli-highlight for syntax-highlighted code blocks.
 *
 * Post-processes output to:
 * - Strip ### markers from h3+ headings
 * - Replace `-` bullets with bullet characters
 */

import { Markdown, type MarkdownTheme } from "@mariozechner/pi-tui";
import chalk, { Chalk } from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";

const LANG_ALIASES: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  yml: "yaml",
};

// Force color output regardless of terminal detection
const c = new Chalk({ level: 3 });

const hlTheme = {
  keyword: c.blue,
  built_in: c.cyan,
  type: c.cyan.bold,
  literal: c.blue,
  number: c.green,
  string: c.green,
  regexp: c.red,
  symbol: c.green,
  class: c.yellow,
  function: c.yellow,
  title: c.yellow,
  params: (s: string) => s,
  comment: c.gray,
  doctag: c.green,
  meta: c.gray,
  section: c.yellow.bold,
  tag: c.gray,
  name: c.blue,
  attr: c.cyan,
  attribute: c.cyan,
  variable: c.red,
  bullet: c.green,
  code: c.green,
  addition: c.green,
  deletion: c.red,
  default: (s: string) => s,
};

function highlightCode(code: string, lang?: string): string[] {
  try {
    const language = lang ? (LANG_ALIASES[lang] ?? lang) : undefined;
    const opts: { language?: string; ignoreIllegals: boolean; theme: typeof hlTheme } = {
      ignoreIllegals: true,
      theme: hlTheme,
    };
    if (language && supportsLanguage(language)) opts.language = language;
    return highlight(code, opts).split("\n");
  } catch {
    return code.split("\n");
  }
}

const mdTheme: MarkdownTheme = {
  heading: c.green.bold,
  link: c.blue,
  linkUrl: c.blue.underline,
  code: c.yellow,
  codeBlock: c.yellow,
  codeBlockBorder: c.dim,
  quote: c.gray.italic,
  quoteBorder: c.gray,
  hr: c.dim,
  listBullet: c.cyan,
  bold: c.bold,
  italic: c.italic,
  strikethrough: c.strikethrough,
  underline: c.underline,
  highlightCode,
};

// ANSI escape sequence pattern
const ANSI = "(?:\\x1b\\[[0-9;]*m)";

// h3+ heading: ANSI codes followed by ###+ space
const HEADING_MARKER_RE = new RegExp(`(${ANSI}*)(#{3,6}) `, "g");

// Unordered list bullet: ANSI codes followed by "- "
const BULLET_RE = new RegExp(`(${ANSI}*)- (${ANSI}*)`, "g");

/**
 * Post-process pi-tui Markdown output to clean up visual artifacts.
 */
function postProcess(output: string): string {
  let result = output;

  // Strip ### markers from h3+ headings
  result = result.replace(HEADING_MARKER_RE, "$1");

  // Replace - bullets with bullet characters
  result = result.replace(BULLET_RE, "$1\u2022 $2");

  // Strip trailing whitespace from each line
  result = result.split("\n").map((line) => line.trimEnd()).join("\n");

  // Remove blank line immediately after heading lines
  const HEADING_LINE = `(?:\\x1b\\[32m\\x1b\\[1m[^\\n]+)`;
  result = result.replace(new RegExp(`(${HEADING_LINE})\\n\\n`, "g"), "$1\n");

  // Collapse 3+ consecutive newlines to 2
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}

/**
 * Render a markdown string to ANSI-formatted terminal text.
 */
export function renderMarkdown(raw: string, width?: number): string {
  if (!raw.trim()) return "";
  try {
    const cols = width ?? process.stdout.columns ?? 80;
    const md = new Markdown(raw, 0, 0, mdTheme);
    const lines = md.render(cols);
    const output = lines.join("\n").replace(/\n+$/, "");
    return postProcess(output);
  } catch {
    return raw;
  }
}
