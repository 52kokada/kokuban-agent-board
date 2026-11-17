// Kokuban visible Kimi wake (D130): types one line into the console of an open Kimi Code window, as if
// its human had typed it and pressed Enter, so board mail starts a turn the person can watch instead of a
// hidden second Kimi process that holds the session lock. Compiled from this source by the daemon with the
// .NET Framework csc that every Windows 10/11 has; no binary is shipped. Built as a window-less exe.
//
//   KokubanType kimi <pid> <base64 line>   walk up from <pid> to the outermost kimi.exe, attach to its
//                                           console, type the line, then press Enter separately
//   KokubanType find <pid>                 print that outermost kimi.exe pid (the prompt hook runs this
//                                           while its short-lived shell parent still exists)
//
// The line must be one line of printable text: a newline would submit part of it early.
// Prints the kimi.exe pid it typed into. Exit 0 on success, 2 otherwise (nothing typed).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class KokubanType {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
  }
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
  struct InputRecord { [FieldOffset(0)] public ushort type; [FieldOffset(4)] public KeyEvent key; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct KeyEvent { public int down; public ushort repeat, vk, scan; public char ch; public uint state; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool First(IntPtr h, ref Entry e);
  [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Next(IntPtr h, ref Entry e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", EntryPoint = "WriteConsoleInputW", SetLastError = true)]
  static extern bool WriteInput(IntPtr h, InputRecord[] records, uint count, out uint written);

  static void Out(string s) {
    var b = new UTF8Encoding(false).GetBytes(s + "\n");
    try { using (var st = Console.OpenStandardOutput()) st.Write(b, 0, b.Length); } catch { }
  }

  /** The outermost kimi.exe of the first run of kimi.exe at or above start: the one whose console is the
   * person's window (a child kimi.exe may run with a hidden console of its own). 0 when the chain holds no
   * kimi.exe, as for a reused pid or a closed window. */
  static uint OuterKimi(uint start) {
    var rows = new Dictionary<uint, Entry>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) return 0;
    try {
      var row = new Entry(); row.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!First(snap, ref row)) return 0;
      do { rows[row.pid] = row; } while (Next(snap, ref row));
    } finally { CloseHandle(snap); }
    var seen = new HashSet<uint>(); uint current = start, found = 0;
    for (int n = 0; n < 8 && current != 0 && seen.Add(current); n++) {
      Entry row; if (!rows.TryGetValue(current, out row)) break;
      if (String.Equals(row.name, "kimi.exe", StringComparison.OrdinalIgnoreCase)) found = current;
      else if (found != 0) break;
      current = row.parent;
    }
    return found;
  }

  static bool Valid(string t) {
    if (String.IsNullOrWhiteSpace(t) || t.Length > 400) return false;
    foreach (char c in t) if (Char.IsControl(c) || Char.IsSurrogate(c)) return false;
    return true;
  }

  static InputRecord Key(char ch, ushort vk, ushort scan, bool down) {
    var r = new InputRecord(); r.type = 1;
    r.key.down = down ? 1 : 0; r.key.repeat = 1; r.key.vk = vk; r.key.scan = scan; r.key.ch = ch;
    return r;
  }

  public static int Main(string[] args) {
    try {
      uint pid; if (args.Length < 2 || !UInt32.TryParse(args[1], out pid) || pid == 0) return 2;
      if (args.Length == 2 && args[0] == "find") {
        uint found = OuterKimi(pid);
        if (found == 0) return 2;
        Out(found.ToString());
        return 0;
      }
      if (args.Length != 3 || args[0] != "kimi") return 2;
      string line = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(args[2]));
      if (!Valid(line)) return 2;
      uint target = OuterKimi(pid);
      if (target == 0) return 2;
      bool typed = false;
      FreeConsole();
      if (!AttachConsole(target)) return 2;
      try {
        IntPtr input = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (input == new IntPtr(-1)) return 2;
        try {
          // Key-down records only. A pseudoconsole (VS Code, Windows Terminal) turns a key-up that carries
          // a character into a second copy of it, so "ab" arrived as "aabb"; a classic console ignores them.
          var records = new List<InputRecord>();
          foreach (char c in line) records.Add(Key(c, 0, 0, true));
          uint written;
          typed = WriteInput(input, records.ToArray(), (uint)records.Count, out written) && written == records.Count;
          // Kimi reads Enter in the same burst as the text as part of a paste. A separate Enter, with its
          // virtual key and scan code, submits.
          System.Threading.Thread.Sleep(300);
          var enter = new[] { Key('\r', 13, 0x1C, true) };
          typed = typed && WriteInput(input, enter, 1, out written) && written == 1;
        } finally { CloseHandle(input); }
      } finally { FreeConsole(); }
      // Report only after detaching: while attached, standard output can be the person's Kimi screen.
      if (typed) Out(target.ToString());
      return typed ? 0 : 2;
    } catch { return 2; }
  }
}
