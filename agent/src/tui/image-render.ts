/**
 * image-render — iTerm2 inline-image + save-to-file fallback for MCP image
 * content blocks surfaced through the ToolPanel expanded view (spec §2.4,
 * qlaybot v0.4.3 Group 4 step 13).
 *
 * The render mode is decided per-call from `process.env.TERM_PROGRAM` so
 * tests can toggle it between cases without module reloads.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ImageRenderMode = "iterm2" | "fallback";

/**
 * Decide whether the current terminal can render an iTerm2 OSC 1337 inline
 * image. Reads `process.env.TERM_PROGRAM` at CALL time (not module load)
 * so tests can mutate the env between cases.
 */
export function detectImageRenderMode(): ImageRenderMode {
  const term = process.env.TERM_PROGRAM || "";
  if (term === "iTerm.app" || term === "WezTerm" || term === "vscode") {
    return "iterm2";
  }
  return "fallback";
}

/**
 * Compute decoded-byte length of a base64 string without actually decoding
 * it. Saves a Buffer.from() allocation when we only need the size for the
 * 2 MB budget check.
 *
 * Spec: empty string → 0. No padding → floor(len*3/4). One "=" → -1.
 * Two "==" → -2.
 */
export function base64DecodedSize(b64: string): number {
  if (b64.length === 0) return 0;
  let len = Math.floor((b64.length * 3) / 4);
  if (b64.endsWith("==")) len -= 2;
  else if (b64.endsWith("=")) len -= 1;
  return len;
}

/**
 * Build the iTerm2 OSC 1337 inline-image escape sequence. The terminal
 * renders the image when it receives this string in its output stream.
 */
export function renderInlineImage(
  base64: string,
  opts?: { width?: string; height?: string },
): string {
  const w = opts?.width ?? "auto";
  const h = opts?.height ?? "auto";
  return `\x1b]1337;File=inline=1;width=${w};height=${h};preserveAspectRatio=1:${base64}\x07`;
}

function extFromMediaType(mediaType: string): string {
  const m = mediaType.toLowerCase();
  if (m === "image/png") return "png";
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/gif") return "gif";
  if (m === "image/webp") return "webp";
  return "bin";
}

/**
 * Write the decoded image bytes to a deterministic-prefix filename in
 * `outDir` and return a single-line marker the TUI can print instead of
 * the iTerm2 escape. Used when the terminal can't render inline OR when
 * the decoded payload exceeds the 2 MB budget.
 */
export function renderFallback(
  base64: string,
  outDir: string,
  mediaType: string = "image/png",
): string {
  const ext = extFromMediaType(mediaType);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const filename = `qlaybot-img-${stamp}.${ext}`;
  const absPath = path.join(outDir, filename);
  const buf = Buffer.from(base64, "base64");
  fs.writeFileSync(absPath, buf);
  return `[image saved: ${absPath}]`;
}
