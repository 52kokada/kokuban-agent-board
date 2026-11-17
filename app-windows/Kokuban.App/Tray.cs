using System.Runtime.InteropServices;

namespace Kokuban.App;

/// <summary>
/// The app's place in the notification area and its hotkey, both on one hidden window of its own:
/// the icon (a click opens the window; the menu holds Open, Pause, Settings and Quit) and
/// RegisterHotKey for Ctrl+Alt+K. It puts the icon back when Explorer restarts.
/// </summary>
public sealed class Tray : IDisposable
{
    public sealed record Item(string Label, Action Run, bool Checked = false);

    private const int WM_APP_TRAY = 0x8000 + 1;
    private const int WM_HOTKEY = 0x0312;
    private const int WM_COMMAND = 0x0111;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_CONTEXTMENU = 0x007B;
    private const int NIN_SELECT = 0x0400;
    private const int NIN_KEYSELECT = 0x0401;
    private const int HOTKEY_ID = 1;

    private readonly WndProc _proc;
    private readonly nint _hwnd;
    private readonly nint _icon;
    private readonly uint _taskbarCreated;
    private string _tip;
    private bool _added;

    public Tray(string iconPath, string tip)
    {
        _tip = tip;
        _proc = Handle;
        var cls = new WNDCLASSEX
        {
            cbSize = Marshal.SizeOf<WNDCLASSEX>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_proc),
            hInstance = GetModuleHandle(null),
            lpszClassName = $"KokubanTray-{Environment.ProcessId}",
        };
        RegisterClassEx(ref cls);
        // An ordinary hidden window, not a message-only one: only top-level windows hear Explorer restart.
        _hwnd = CreateWindowEx(0, cls.lpszClassName, "Kokuban", 0, 0, 0, 0, 0, 0, 0, cls.hInstance, 0);
        _taskbarCreated = RegisterWindowMessage("TaskbarCreated");
        _icon = LoadImage(0, iconPath, 1, GetSystemMetrics(49), GetSystemMetrics(50), 0x10);
        Add();
    }

    /// <summary>The menu, asked for each time it opens so it shows the present state and language.</summary>
    public Func<IReadOnlyList<Item?>>? Menu { get; set; }

    public event Action? Clicked;

    public event Action? Hotkey;

    public void SetTip(string tip)
    {
        _tip = tip;
        if (_added) Notify(1 /* NIM_MODIFY */);
    }

    /// <summary>Hold a hotkey for the whole session; false when another program has it.</summary>
    public bool HoldHotkey(uint modifiers, uint key)
    {
        UnregisterHotKey(_hwnd, HOTKEY_ID);
        return RegisterHotKey(_hwnd, HOTKEY_ID, modifiers | 0x4000 /* MOD_NOREPEAT */, key);
    }

    private void Add()
    {
        _added = Notify(0 /* NIM_ADD */);
        if (!_added)
        {
            Log.Write("the tray icon could not be added");
            return;
        }
        var data = Data();
        data.uVersion = 4;
        Shell_NotifyIcon(4 /* NIM_SETVERSION */, ref data);
    }

    private NOTIFYICONDATA Data() => new()
    {
        cbSize = Marshal.SizeOf<NOTIFYICONDATA>(),
        hWnd = _hwnd,
        uID = 1,
        uFlags = 0x1 | 0x2 | 0x4 | 0x80, // message, icon, tip, show tip
        uCallbackMessage = WM_APP_TRAY,
        hIcon = _icon,
        szTip = _tip.Length > 127 ? _tip[..127] : _tip,
    };

    private bool Notify(uint message)
    {
        var data = Data();
        return Shell_NotifyIcon(message, ref data);
    }

    private nint Handle(nint hwnd, uint msg, nint wParam, nint lParam)
    {
        if (msg == _taskbarCreated)
        {
            Add();
            return 0;
        }
        if (msg == WM_HOTKEY && wParam == HOTKEY_ID)
        {
            Hotkey?.Invoke();
            return 0;
        }
        if (msg == WM_APP_TRAY)
        {
            // Version 4: the event is in the low word of lParam.
            switch ((int)(lParam & 0xFFFF))
            {
                case NIN_SELECT or NIN_KEYSELECT or WM_LBUTTONUP:
                    Clicked?.Invoke();
                    break;
                case WM_CONTEXTMENU or WM_RBUTTONUP:
                    ShowMenu();
                    break;
            }
            return 0;
        }
        return DefWindowProc(hwnd, msg, wParam, lParam);
    }

    private void ShowMenu()
    {
        var items = Menu?.Invoke() ?? [];
        var menu = CreatePopupMenu();
        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            if (item is null) AppendMenu(menu, 0x800 /* MF_SEPARATOR */, 0, null);
            else AppendMenu(menu, item.Checked ? 0x8u /* MF_CHECKED */ : 0, (nuint)(i + 1), item.Label);
        }
        GetCursorPos(out var p);
        // Without the foreground, the menu would not close when the person clicks elsewhere.
        SetForegroundWindow(_hwnd);
        var chosen = TrackPopupMenuEx(menu, 0x100 /* TPM_RETURNCMD */ | 0x80 /* TPM_NONOTIFY */ | 0x2 /* TPM_RIGHTBUTTON */, p.X, p.Y, _hwnd, 0);
        DestroyMenu(menu);
        if (chosen > 0 && items[chosen - 1] is { } pick) pick.Run();
    }

    public void Dispose()
    {
        UnregisterHotKey(_hwnd, HOTKEY_ID);
        if (_added) Notify(2 /* NIM_DELETE */);
        DestroyWindow(_hwnd);
        if (_icon != 0) DestroyIcon(_icon);
    }

    // -- Win32 ---------------------------------------------------------------------------------------

    private delegate nint WndProc(nint hwnd, uint msg, nint wParam, nint lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public int cbSize;
        public uint style;
        public nint lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public nint hInstance, hIcon, hCursor, hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATA
    {
        public int cbSize;
        public nint hWnd;
        public uint uID, uFlags, uCallbackMessage;
        public nint hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public uint dwState, dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public uint uVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public nint hBalloonIcon;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassEx(ref WNDCLASSEX c);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint CreateWindowEx(uint ex, string cls, string name, uint style, int x, int y, int w, int h, nint parent, nint menu, nint inst, nint param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint DefWindowProc(nint hwnd, uint msg, nint w, nint l);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(nint hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandle(string? name);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern bool Shell_NotifyIcon(uint msg, ref NOTIFYICONDATA data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint LoadImage(nint inst, string name, uint type, int cx, int cy, uint load);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(nint icon);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool RegisterHotKey(nint hwnd, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(nint hwnd, int id);
    [DllImport("user32.dll")] private static extern nint CreatePopupMenu();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool AppendMenu(nint menu, uint flags, nuint id, string? text);
    [DllImport("user32.dll")] private static extern int TrackPopupMenuEx(nint menu, uint flags, int x, int y, nint hwnd, nint tpm);
    [DllImport("user32.dll")] private static extern bool DestroyMenu(nint menu);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Native.Point p);
}
