import type { Result } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import { spawn } from "child_process";
import { mkdtemp } from "fs/promises";
import os from "os";
import path from "path";

import { normalizeError } from "./errors.js";

// Terminals deliver a real OS paste (Ctrl+V) as plain text keystrokes over
// stdin - there is no way to receive binary clipboard image data that way.
// So this reads the clipboard directly via a small platform script instead
// of going through the terminal at all.
//
// Handles two distinct cases on both platforms, since both are common ways
// to "copy an image":
//   1. Raw image data - e.g. Snipping Tool, Win+Shift+S, macOS
//      Cmd+Ctrl+Shift+4, a browser's "Copy image".
//   2. A file reference - e.g. Ctrl+C on an image file in Explorer, or
//      Cmd+C on a Finder selection. The raw-image-data check alone misses
//      this case even though there visibly "is an image" copied.
const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  $img.Save("__OUT_PATH_PNG__", [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "OK:__OUT_PATH_PNG__"
}
elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $imageExtensions = @(".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp")
  $imageFile = [System.Windows.Forms.Clipboard]::GetFileDropList() |
    Where-Object { $imageExtensions -contains [System.IO.Path]::GetExtension($_).ToLower() } |
    Select-Object -First 1
  if ($imageFile) {
    Write-Output "OK:$imageFile"
  } else {
    Write-Output "NO_IMAGE"
  }
}
else {
  Write-Output "NO_IMAGE"
}
`;

// Untested - there was no macOS machine available to verify this against a
// real clipboard. «class furl»/«class PNGf»/«class TIFF» are the standard
// AppleScript class codes for a Finder file reference, PNG data, and TIFF
// data respectively; this is the commonly-documented approach for reading
// clipboard images via osascript with no extra dependency (no pngpaste
// etc.), but please verify it actually works before relying on it.
const MACOS_SCRIPT = `
try
  set fileRef to (the clipboard as «class furl»)
  return "OK:" & (POSIX path of fileRef)
end try

try
  set imgData to (the clipboard as «class PNGf»)
  set outFile to open for access (POSIX file "__OUT_PATH_PNG__") with write permission
  set eof outFile to 0
  write imgData to outFile
  close access outFile
  return "OK:__OUT_PATH_PNG__"
end try

try
  set imgData to (the clipboard as «class TIFF»)
  set outFile to open for access (POSIX file "__OUT_PATH_TIFF__") with write permission
  set eof outFile to 0
  write imgData to outFile
  close access outFile
  return "OK:__OUT_PATH_TIFF__"
end try

return "NO_IMAGE"
`;

function runScript(
  command: string,
  args: string[]
): Promise<Result<string, Error>> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve(new Err(normalizeError(error)));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(
          new Err(
            new Error(stderr.trim() || `${command} exited with code ${code}`)
          )
        );
        return;
      }
      resolve(new Ok(stdout));
    });
  });
}

/**
 * Resolves the current clipboard image (if any) to a file path - either a
 * freshly-saved temp file (raw image data case) or the original file's own
 * path (file-reference case). Returns Ok(null) - not an error - when the
 * platform is unsupported or the clipboard simply doesn't contain an image
 * right now.
 */
export async function getClipboardImagePath(): Promise<
  Result<string | null, Error>
> {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    return new Ok(null);
  }

  let tmpDir: string;
  try {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "dust-cli-clipboard-"));
  } catch (error) {
    return new Err(normalizeError(error));
  }
  const outPathPng = path.join(tmpDir, `pasted-${Date.now()}.png`);
  const outPathTiff = path.join(tmpDir, `pasted-${Date.now()}.tiff`);

  const runRes =
    process.platform === "win32"
      ? await runScript("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_SCRIPT.replaceAll("__OUT_PATH_PNG__", outPathPng),
        ])
      : await runScript("osascript", [
          "-e",
          MACOS_SCRIPT.replaceAll("__OUT_PATH_PNG__", outPathPng).replaceAll(
            "__OUT_PATH_TIFF__",
            outPathTiff
          ),
        ]);

  if (runRes.isErr()) {
    return runRes;
  }

  const match = runRes.value.match(/OK:(.+)/s);
  return new Ok(match ? match[1].trim() : null);
}
