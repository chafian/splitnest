# Reads a console's screen WITHOUT touching the shell: attaches to the console that process <pid>
# belongs to (AttachConsole), reads the visible window rows, the cursor and the window size, and
# detaches. Nothing is typed into the shell, so the probe cannot scroll or alter what it measures.
# Long-running: reads one PID per line from stdin, answers one JSON line per request (so the C#
# helper is compiled once).
#   in:  1234
#   out: {"ok":true,"cols":80,"rows":24,"cursorX":5,"cursorY":3,"rows":[...]}  or {"ok":false,"error":"..."}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ConsoleProbe {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Window; public COORD Max; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD at, out uint read);
  static string Esc(string s) { var b = new StringBuilder(); foreach (var c in s) { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 32) b.AppendFormat("\\u{0:x4}", (int)c); else b.Append(c); } return b.ToString(); }
  public static string Read(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "{\"ok\":false,\"error\":\"AttachConsole " + Marshal.GetLastWin32Error() + "\"}";
    try {
      IntPtr h = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h == new IntPtr(-1)) return "{\"ok\":false,\"error\":\"CONOUT " + Marshal.GetLastWin32Error() + "\"}";
      try {
        CSBI i; if (!GetConsoleScreenBufferInfo(h, out i)) return "{\"ok\":false,\"error\":\"CSBI " + Marshal.GetLastWin32Error() + "\"}";
        int cols = i.Window.Right - i.Window.Left + 1, rows = i.Window.Bottom - i.Window.Top + 1;
        var sb = new StringBuilder("{\"ok\":true,\"cols\":" + cols + ",\"rows\":" + rows + ",\"bufferHeight\":" + i.Size.Y + ",\"windowTop\":" + i.Window.Top + ",\"cursorX\":" + (i.Cursor.X - i.Window.Left) + ",\"cursorY\":" + (i.Cursor.Y - i.Window.Top) + ",\"lines\":[");
        for (int y = 0; y < rows; y++) {
          var buf = new StringBuilder(cols); uint read;
          var at = new COORD { X = i.Window.Left, Y = (short)(i.Window.Top + y) };
          ReadConsoleOutputCharacterW(h, buf, (uint)cols, at, out read);
          if (y > 0) sb.Append(',');
          sb.Append('"').Append(Esc(buf.ToString(0, (int)read).TrimEnd())).Append('"');
        }
        return sb.Append("]}").ToString();
      } finally { CloseHandle(h); }
    } finally { FreeConsole(); }
  }
}
'@
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = 0
  if (-not [uint32]::TryParse($line.Trim(), [ref]$id)) { [Console]::Out.WriteLine('{"ok":false,"error":"bad pid"}'); continue }
  [Console]::Out.WriteLine([ConsoleProbe]::Read($id))
}
