# Share of "ink" pixels (text) in a rectangle of each PNG frame in a folder, as a JSON array in
# file order. Used by run-resize.mjs to spot frames where a terminal is briefly blank (flicker).
# Ink = a pixel whose brightest channel is above 90 (text on the dark default theme, whose
# terminal background is #0c0c0e).
param([string] $Dir, [int] $X, [int] $Y, [int] $W, [int] $H)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class Ink {
  public static double Share(string file, int x, int y, int w, int h) {
    using (var bmp = new Bitmap(file)) {
      x = Math.Max(0, Math.Min(x, bmp.Width - 1)); y = Math.Max(0, Math.Min(y, bmp.Height - 1));
      w = Math.Min(w, bmp.Width - x); h = Math.Min(h, bmp.Height - y);
      var data = bmp.LockBits(new Rectangle(x, y, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        var bytes = new byte[data.Stride * h];
        Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
        long ink = 0, total = 0;
        for (int row = 0; row < h; row++) {
          for (int col = 0; col < w; col++) {
            int i = row * data.Stride + col * 4;
            int b = bytes[i], g = bytes[i + 1], r = bytes[i + 2];
            int max = Math.Max(r, Math.Max(g, b));
            total++;
            if (max > 90) ink++;
          }
        }
        return total == 0 ? 0 : (double)ink / total;
      } finally { bmp.UnlockBits(data); }
    }
  }
}
'@
$values = Get-ChildItem $Dir -Filter *.png | Sort-Object Name | ForEach-Object { [math]::Round([Ink]::Share($_.FullName, $X, $Y, $W, $H), 4) }
ConvertTo-Json @($values) -Compress
