// Kokuban terminal badges (D125, settings terminalStatusBadges): sets a terminal tab title through the
// console API, so it reaches Windows Terminal, conhost and VS Code tabs alike. Written for Kokuban from
// the approach of earlier TitleProcess/KimiTitleProcess tools (no binary is shipped: install.ts compiles this
// file with the .NET Framework csc that every Windows 10/11 has). Built as a window-less exe, so it never
// opens a console of its own.
//
//   KokubanTitle set  <pid> <base64 title>       attach to <pid>'s console and set its title
//   KokubanTitle kimi <hook pid> <base64 title>  walk up past kimi.exe to the shell whose console is the tab
//   KokubanTitle get  <pid>                       print the console title (tests and checks)
//
// Prints the target pid (or the title for get). Exit 0 on success, 2 otherwise.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class KokubanTitle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool First(IntPtr h, ref Entry e);
  [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Next(IntPtr h, ref Entry e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", EntryPoint = "SetConsoleTitleW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetTitle(string title);
  [DllImport("kernel32.dll", EntryPoint = "GetConsoleTitleW", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetTitle(StringBuilder sb, uint size);

  static void Out(string s) {
    var b = new UTF8Encoding(false).GetBytes(s + "\n");
    try { using (var st = Console.OpenStandardOutput()) st.Write(b, 0, b.Length); } catch { }
  }

  /** The first ancestor past the kimi.exe processes: Kimi forwards its title to that shell's console. */
  static uint PastKimi(uint start) {
    var rows = new Dictionary<uint, Entry>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) return 0;
    try {
      var row = new Entry(); row.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!First(snap, ref row)) return 0;
      do { rows[row.pid] = row; } while (Next(snap, ref row));
    } finally { CloseHandle(snap); }
    var seen = new HashSet<uint>(); uint current = start; bool sawKimi = false;
    for (int n = 0; n < 16 && current != 0 && seen.Add(current); n++) {
      Entry row; if (!rows.TryGetValue(current, out row)) return 0;
      bool kimi = String.Equals(row.name, "kimi.exe", StringComparison.OrdinalIgnoreCase);
      if (kimi) sawKimi = true; else if (sawKimi) return current;
      current = row.parent;
    }
    return 0;
  }

  static string Read() {
    var sb = new StringBuilder(1024); uint n = GetTitle(sb, 1024);
    return sb.ToString(0, (int)Math.Min(n, (uint)sb.Length));
  }

  static bool Valid(string t) {
    if (String.IsNullOrWhiteSpace(t) || t.Length > 120) return false;
    foreach (char c in t) if (Char.IsControl(c)) return false;
    return true;
  }

  public static int Main(string[] args) {
    try {
      if (args.Length < 2) return 2;
      uint pid; if (!UInt32.TryParse(args[1], out pid) || pid == 0) return 2;
      FreeConsole();
      if (args[0] == "get") {
        if (!AttachConsole(pid)) return 2;
        try { Out(Read()); return 0; } finally { FreeConsole(); }
      }
      if (args.Length < 3 || (args[0] != "set" && args[0] != "kimi")) return 2;
      string title = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(args[2]));
      if (!Valid(title)) return 2;
      uint target = args[0] == "kimi" ? PastKimi(pid) : pid;
      if (target == 0 || !AttachConsole(target)) return 2;
      try {
        if (!SetTitle(title)) return 2;
        Out(target.ToString());
        return 0;
      } finally { FreeConsole(); }
    } catch { return 2; }
  }
}
