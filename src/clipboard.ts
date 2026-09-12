/**
 * Reading an image off the OS clipboard.
 *
 * Terminals only carry text, so Ctrl+V is useless for screenshots. Instead we
 * ask the platform clipboard directly and hand the bytes to the model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ImagePart } from "./tools.ts";

export type ClipboardResult =
  | { ok: true; image: ImagePart; label: string }
  | { ok: false; reason: string; hint?: string };

const configuredImageBytes = Number(process.env.RAW_MAX_IMAGE_BYTES);
const MAX_IMAGE_BYTES = Number.isFinite(configuredImageBytes) && configuredImageBytes > 0
  ? Math.max(1024, Math.floor(configuredImageBytes))
  : 20 * 1024 * 1024;
const tmpFile = (ext: string) => path.join(os.tmpdir(), `raw-paste-${process.pid}-${randomUUID()}.${ext}`);

function run(cmd: string, args: string[], timeout = 15_000) {
  return spawnSync(cmd, args, { timeout, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

function detectImageMime(file: string): string | null {
  const head = Buffer.alloc(12);
  const fd = fs.openSync(file, "r");
  let read = 0;
  try {
    read = fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (read >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (read >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (read >= 6 && ["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (read >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function readFileAsImage(file: string, label: string): ClipboardResult | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 32) return null;
    if (stat.size > MAX_IMAGE_BYTES) {
      return { ok: false, reason: `image is too large (${Math.ceil(stat.size / 1024 / 1024)} MB; limit ${Math.ceil(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` };
    }
    const mime = detectImageMime(file);
    if (!mime) return null;
    const data = fs.readFileSync(file).toString("base64");
    return { ok: true, image: { mime, data }, label };
  } catch {
    return null;
  }
}

function readTemporaryImage(file: string, label: string): ClipboardResult | null {
  try {
    return readFileAsImage(file, label);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
}

/* ------------------------------- windows ------------------------------- */

function windowsClipboard(): ClipboardResult {
  const file = tmpFile("png");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) {
  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
  if ($files.Count -gt 0) { Write-Output ("FILE:" + $files[0]); exit 0 }
  exit 3
}
$img.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK"
`;
  const r = run("powershell", ["-NoProfile", "-STA", "-Command", script]);
  const stdout = (r.stdout ?? "").trim();
  if (stdout.startsWith("FILE:")) {
    const p = stdout.slice(5).trim();
    return readFileAsImage(p, path.basename(p)) ?? { ok: false, reason: `cannot read ${p}` };
  }
  if (stdout.includes("OK")) {
    return readTemporaryImage(file, "clipboard.png") ?? { ok: false, reason: "clipboard image was empty" };
  }
  return {
    ok: false,
    reason: "no image on the clipboard",
    hint: "copy a screenshot first (Win+Shift+S), or paste a file path",
  };
}

/* -------------------------------- macOS -------------------------------- */

function macClipboard(): ClipboardResult {
  const file = tmpFile("png");
  // pngpaste is the friendliest if present
  const pngpaste = run("/bin/sh", ["-c", "command -v pngpaste"]).stdout?.trim();
  if (pngpaste) {
    const r = run("pngpaste", [file]);
    const image = r.status === 0 ? readTemporaryImage(file, "clipboard.png") : null;
    if (image) return image;
  }
  const script = `
set outFile to POSIX file "${file}"
try
  set png to (the clipboard as «class PNGf»)
  set fh to open for access outFile with write permission
  set eof fh to 0
  write png to fh
  close access fh
  return "OK"
on error errMsg
  return "ERR:" & errMsg
end try`;
  const r = run("osascript", ["-e", script]);
  const stdout = (r.stdout ?? "").trim();
  if (stdout === "OK") {
    return readTemporaryImage(file, "clipboard.png") ?? { ok: false, reason: "clipboard image was empty" };
  }
  return {
    ok: false,
    reason: stdout.replace(/^ERR:/, "") || "no image on the clipboard",
    hint: "copy a screenshot first (⌃⇧⌘4), or install pngpaste",
  };
}

/* -------------------------------- linux -------------------------------- */

function linuxClipboard(): ClipboardResult {
  const file = tmpFile("png");
  const attempts: { cmd: string; args: string[] }[] = [];
  if (process.env.WAYLAND_DISPLAY) attempts.push({ cmd: "wl-paste", args: ["-t", "image/png"] });
  attempts.push({ cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] });

  let lastError = "no clipboard tool found";
  for (const { cmd, args } of attempts) {
    const result = spawnSync(cmd, args, { timeout: 15_000, windowsHide: true, maxBuffer: MAX_IMAGE_BYTES + 1 });
    if (result.status === 0 && result.stdout) {
      fs.writeFileSync(file, result.stdout);
      const image = readTemporaryImage(file, "clipboard.png");
      if (image) return image;
      lastError = "clipboard holds no image";
    } else {
      lastError = `${cmd} failed`;
    }
  }
  return {
    ok: false,
    reason: lastError,
    hint: "install wl-clipboard or xclip, or paste a file path",
  };
}

/* ---------------------------------------------------------------------- */

export function readClipboardImage(): ClipboardResult {
  try {
    if (process.platform === "win32") return windowsClipboard();
    if (process.platform === "darwin") return macClipboard();
    return linuxClipboard();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export const isImagePath = (p: string) => IMAGE_EXT.test(p);

export function readImageFile(p: string): ClipboardResult {
  const trimmed = p.trim();
  const input = trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
  const abs = path.resolve(input);
  return readFileAsImage(abs, path.basename(abs)) ?? { ok: false, reason: `cannot read image: ${p}` };
}

/** pull image paths out of a message: `@shot.png` or a bare path */
export function extractImagePaths(text: string): { paths: string[]; cleaned: string } {
  const paths: string[] = [];
  const cleaned = text.replace(/(^|\s)@?("[^"]+"|\S+\.(?:png|jpe?g|gif|webp))/gi, (match, lead: string, raw: string) => {
    const candidate = raw.replace(/^"|"$/g, "");
    if (!isImagePath(candidate)) return match;
    if (!fs.existsSync(candidate)) return match;
    paths.push(candidate);
    return lead;
  });
  return { paths, cleaned: cleaned.replace(/\s{2,}/g, " ").trim() };
}
