using System.Runtime.InteropServices;

namespace Kokuban.App;

/// <summary>The few Win32 calls WinUI has no word for: the pointer, click-through, the window frame, the hotkey.</summary>
internal static partial class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Point
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out Point p);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(nint hwnd);

    [DllImport("psapi.dll")]
    public static extern bool EmptyWorkingSet(nint process);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(nint hwnd, out Rect r);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern nint GetWindowLongPtr(nint hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    public static extern nint SetWindowLongPtr(nint hwnd, int index, nint value);

    [DllImport("user32.dll")]
    public static extern bool SetLayeredWindowAttributes(nint hwnd, uint key, byte alpha, uint flags);

    [DllImport("user32.dll")]
    public static extern nint MonitorFromPoint(Point p, uint flags);

    private delegate bool MonitorEnumProc(nint monitor, nint dc, ref Rect bounds, nint data);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumDisplayMonitors(nint dc, nint clip, MonitorEnumProc callback, nint data);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor, Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayDevice
    {
        public int Size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Key;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplayDevices(string name, uint index, ref DisplayDevice device, uint flags);
    private static readonly Kokuban.Core.LocalUiOptions LocalUi = AppSettings.Load().LocalUi ?? new();
    public static bool RestrictPillToMonitor => LocalUi.RestrictPillToMonitor;
    public static bool RevealPillOnHover => LocalUi.RevealPillOnHover;

    public static Rect? PillWorkArea()
    {
        var monitors = new List<Kokuban.Core.PillMonitor>();
        var areas = new Dictionary<string, Rect>();
        var valid = true;
        bool Visit(nint monitor, nint dc, ref Rect bounds, nint data)
        {
            var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>(), Device = "" };
            if (!GetMonitorInfo(monitor, ref info)) { valid = false; return false; }
            var device = new DisplayDevice { Size = Marshal.SizeOf<DisplayDevice>() };
            if (!EnumDisplayDevices(info.Device, 0, ref device, 1) || string.IsNullOrWhiteSpace(device.Id))
            { valid = false; return false; }
            monitors.Add(new(device.Id, (info.Flags & 1) != 0, bounds.Left, bounds.Top, bounds.Right, bounds.Bottom));
            areas[device.Id] = info.Work;
            return true;
        }
        if (!EnumDisplayMonitors(0, 0, Visit, 0) || !valid) return null;
        var selected = Kokuban.Core.PillPlacement.Select(monitors, LocalUi.PillMonitorDeviceId);
        return selected is null ? null : areas[selected.Id];
    }

    internal delegate nint SubclassProc(nint hwnd, uint message, nint wparam, nint lparam, nuint id, nuint data);
    [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(nint hwnd, SubclassProc callback, nuint id, nuint data);
    [DllImport("comctl32.dll")] private static extern nint DefSubclassProc(nint hwnd, uint message, nint wparam, nint lparam);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(nint hwnd);
    [StructLayout(LayoutKind.Sequential)]
    private struct WindowPosition { public nint Hwnd, After; public int X, Y, Width, Height; public uint Flags; }

    // Reject OS relocation onto a forbidden screen as well as our own moves. Hide
    // synchronously on topology changes, before a later UI timer can run.
    public static SubclassProc GuardPill(nint window)
    {
        SubclassProc callback = (hwnd, message, wparam, lparam, id, data) =>
        {
            if (!RestrictPillToMonitor) return DefSubclassProc(hwnd, message, wparam, lparam);
            if (message == 0x007E) ShowWindow(hwnd, 0); // WM_DISPLAYCHANGE
            if (message == 0x0046 && !Program.Offscreen) // WM_WINDOWPOSCHANGING
            {
                var pos = Marshal.PtrToStructure<WindowPosition>(lparam);
                var area = PillWorkArea();
                var ok = GetWindowRect(hwnd, out var current);
                var x = (pos.Flags & 2) != 0 ? current.Left : pos.X;
                var y = (pos.Flags & 2) != 0 ? current.Top : pos.Y;
                var w = (pos.Flags & 1) != 0 ? current.Right - current.Left : pos.Width;
                var h = (pos.Flags & 1) != 0 ? current.Bottom - current.Top : pos.Height;
                if (!ok || area is not { } a || x < a.Left || y < a.Top || x + w > a.Right || y + h > a.Bottom)
                {
                    pos.Flags = (pos.Flags | 0x0080u) & ~0x0040u; // hide, never show
                    Marshal.StructureToPtr(pos, lparam, false);
                }
            }
            return DefSubclassProc(hwnd, message, wparam, lparam);
        };
        if (!SetWindowSubclass(window, callback, 1, 0)) throw new InvalidOperationException("Pill placement guard could not be installed");
        return callback;
    }

    [DllImport("shcore.dll")]
    public static extern int GetDpiForMonitor(nint monitor, int type, out uint dpiX, out uint dpiY);

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(nint hwnd, int attribute, ref int value, int size);

    public const int GWL_EXSTYLE = -20;
    public const nint WS_EX_LAYERED = 0x80000;
    public const nint WS_EX_TRANSPARENT = 0x20;
    public const nint WS_EX_TOOLWINDOW = 0x80;
    public const nint WS_EX_NOACTIVATE = 0x8000000;
    public const uint LWA_ALPHA = 2;
    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWA_BORDER_COLOR = 34;
    public const int DWMWCP_DONOTROUND = 1;
    public const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);

    /// <summary>The scale of the monitor a screen point is on (1.0 at 96 dpi).</summary>
    public static double ScaleAt(Point p)
    {
        var monitor = MonitorFromPoint(p, 2);
        return GetDpiForMonitor(monitor, 0, out var dpi, out _) == 0 ? dpi / 96.0 : 1.0;
    }

    public const int GWL_STYLE = -16;
    public const nint WS_BORDER = 0x800000;
    public const nint WS_DLGFRAME = 0x400000;
    public const nint WS_CAPTION = 0xC00000;
    public const nint WS_THICKFRAME = 0x40000;

    public static void SetStyle(nint hwnd, nint add, nint remove)
    {
        var style = GetWindowLongPtr(hwnd, GWL_STYLE);
        var next = (style | add) & ~remove;
        if (next != style) SetWindowLongPtr(hwnd, GWL_STYLE, next);
    }

    public static void SetExStyle(nint hwnd, nint add, nint remove)
    {
        var style = GetWindowLongPtr(hwnd, GWL_EXSTYLE);
        var next = (style | add) & ~remove;
        if (next != style) SetWindowLongPtr(hwnd, GWL_EXSTYLE, next);
    }
}
