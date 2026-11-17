param([switch]$Stream)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AgentWindows {
  public delegate bool Callback(IntPtr hwnd, IntPtr extra);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr extra);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, Callback cb, IntPtr extra);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDesktopManager {
    [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr hwnd, out bool current);
    [PreserveSig] int GetWindowDesktopId(IntPtr hwnd, out Guid desktop);
    [PreserveSig] int MoveWindowToDesktop(IntPtr hwnd, ref Guid desktop);
  }
  public class Window {
    public long hwnd;
    public uint pid;
    public string title;
    public string desktopId;
  }
  public static long[] Children(long parent) {
    var handles = new List<long>();
    EnumChildWindows(new IntPtr(parent), delegate(IntPtr hwnd, IntPtr extra) {
      if (IsWindowVisible(hwnd)) handles.Add(hwnd.ToInt64());
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }
  public static Window[] List() {
    var result = new List<Window>();
    object manager = null;
    try { manager = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a"))); } catch {}
    try {
      EnumWindows(delegate(IntPtr hwnd, IntPtr extra) {
        if (!IsWindowVisible(hwnd)) return true;
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        var title = new StringBuilder(4096); GetWindowText(hwnd, title, title.Capacity);
        string desktopId = null;
        try { Guid desktop; if (manager != null && ((IDesktopManager)manager).GetWindowDesktopId(hwnd, out desktop) == 0) desktopId = desktop.ToString(); } catch {}
        result.Add(new Window { hwnd=hwnd.ToInt64(), pid=pid, title=title.ToString(), desktopId=desktopId });
        return true;
      }, IntPtr.Zero);
    } finally { if (manager != null) Marshal.ReleaseComObject(manager); }
    return result.ToArray();
  }
}
'@
function Get-AgentWindowSnapshot {
$capturedAt = [DateTime]::UtcNow.ToString('o')
$ownSession = (Get-Process -Id $PID).SessionId
$desktopSessions = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SessionId -Unique)
if ($ownSession -eq 0 -or $desktopSessions.Count -ne 1 -or $desktopSessions[0] -ne $ownSession) {
    throw 'Collector is not in the interactive user session.'
}
$runtime = @()
foreach ($proc in Get-CimInstance Win32_Process) {
    if ($proc.Name -in @('WindowsTerminal.exe', 'Code.exe') -and $proc.SessionId -ne $ownSession) {
        throw 'Some terminals are in another Windows login session.'
    }
    $runtimeHost = $null
    if ($proc.Name -eq 'claude.exe' -and $proc.CommandLine -notmatch '(?:^|\s)(?:--print|-p)(?:\s|$)') { $runtimeHost = 'claude' }
    if ($proc.Name -match '^(kimi|python|python3|uv)\.exe$' -and $proc.CommandLine -match '\bkimi\b' -and $proc.CommandLine -notmatch '(?:--print|--prompt|--quiet)') { $runtimeHost = 'kimi' }
    if ($runtimeHost -and $proc.SessionId -eq $ownSession) {
        $runtime += @{ pid = [int]$proc.ProcessId; host = $runtimeHost; started = [DateTimeOffset]::new($proc.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() }
    }
}
$desktopIds = @()
try {
    $bytes = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops').VirtualDesktopIDs
    for ($offset = 0; $offset + 16 -le $bytes.Length; $offset += 16) {
        $desktopIds += [Guid]::new([byte[]]$bytes[$offset..($offset + 15)]).ToString()
    }
} catch { }
$processNames = @{}
Get-Process | ForEach-Object { $processNames[[int]$_.Id] = $_.ProcessName }
$windows = @()
foreach ($win in [AgentWindows]::List()) {
    $app = $processNames[[int]$win.pid]
    if ($app -notin @('WindowsTerminal', 'Code')) { continue }
    $elements = @()
    $scanError = $null
    try {
        $conditions = [System.Windows.Automation.Condition[]]@(
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem),
            [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
        )
        # On another desktop, UIA omits child HWND islands from the parent tree.
        # Read those HWNDs directly without activating or moving any window.
        foreach ($handle in @($win.hwnd) + [AgentWindows]::Children($win.hwnd)) {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
            $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.OrCondition]::new($conditions))
            foreach ($node in $nodes) {
                $current = $node.Current
                $role = $current.ControlType.ProgrammaticName.Replace('ControlType.', '')
                if ($role -eq 'Edit' -and $current.Name -notmatch '^Terminal \d+, ') { continue }
                $elements += @{ role = $role; name = $current.Name }
            }
        }
        if ($elements.Count -eq 0) { $scanError = 'No tab or terminal controls could be read; coverage is unknown.' }
    } catch { $scanError = $_.Exception.Message }
    $desktopIndex = [Array]::IndexOf($desktopIds, $win.desktopId)
    $windows += @{
        hwnd = $win.hwnd; pid = $win.pid; app = $app; title = $win.title
        desktop = $(if ($desktopIndex -ge 0) { $desktopIndex + 1 } else { $null })
        desktopId = $win.desktopId; elements = $elements; scanError = $scanError
    }
}
ConvertTo-Json -InputObject @{ capturedAt = $capturedAt; windows = $windows; runtime = $runtime; interactive = $true; sessionId = $ownSession } -Depth 8 -Compress
}
if ($Stream) {
    while ($null -ne ($request = [Console]::ReadLine())) {
        if ($request -eq 'scan') {
            [Console]::WriteLine((Get-AgentWindowSnapshot))
            [Console]::Out.Flush()
        }
    }
} else {
    Get-AgentWindowSnapshot
}
