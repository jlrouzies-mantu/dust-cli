import type { Result } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import { spawn } from "child_process";
import { mkdtemp } from "fs/promises";
import os from "os";
import path from "path";

import { normalizeError } from "./errors.js";

// Terminals deliver a real OS paste (Ctrl+V) as plain text keystrokes over
// stdin - there is no way to receive binary clipboard image data that way.
// So this reads the clipboard directly via a small PowerShell snippet
// instead of going through the terminal at all. Windows-only for now: the
// System.Windows.Forms.Clipboard API this relies on has no equivalent this
// simple on macOS/Linux.
//
// Handles two distinct cases, since both are common ways to "copy an
// image" on Windows and they use entirely different clipboard formats:
//   1. Raw image data (Clipboard.ContainsImage()) - e.g. Snipping Tool,
//      Win+Shift+S, a browser's "Copy image".
//   2. A file reference (Clipboard.ContainsFileDropList()) - e.g.
//      Ctrl+C on an image file in Explorer. GetImage() returns nothing
//      for this case even though there visibly "is an image" copied.
const CLIPBOARD_IMAGE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  $img.Save("__OUT_PATH__", [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "OK:__OUT_PATH__"
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

/**
 * Resolves the current clipboard image (if any) to a file path - either a
 * freshly-saved temp PNG (raw image data case) or the original file's own
 * path (file-reference case). Returns Ok(null) - not an error - when the
 * platform is unsupported or the clipboard simply doesn't contain an image
 * right now.
 */
export async function getClipboardImagePath(): Promise<
  Result<string | null, Error>
> {
  if (process.platform !== "win32") {
    return new Ok(null);
  }

  let tmpDir: string;
  try {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "dust-cli-clipboard-"));
  } catch (error) {
    return new Err(normalizeError(error));
  }
  const outPath = path.join(tmpDir, `pasted-${Date.now()}.png`);
  const script = CLIPBOARD_IMAGE_SCRIPT.replaceAll("__OUT_PATH__", outPath);

  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true }
    );

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
            new Error(
              stderr.trim() || `powershell.exe exited with code ${code}`
            )
          )
        );
        return;
      }
      const match = stdout.match(/OK:(.+)/s);
      resolve(new Ok(match ? match[1].trim() : null));
    });
  });
}
