using Kokuban.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace Kokuban.App;

/// <summary>
/// Kokuban for Windows: one resident process in the tray (decision 1 of the native app). It starts at
/// sign-in, holds the hotkey, follows the board and brings the pill up itself the moment something
/// new waits on the person. Arguments, from the first start or handed over by a later one:
///
///   (none)               the window
///   --pill               the hotkey's first press: the pill when something waits, else the window
///   --item &lt;thread&gt;     the window on that item
///   --background         nothing on screen (the sign-in entry)
///   --settings           the settings
///   --quit               end the app
///   --theme light|dark   --lang en|ja   for side-by-side checks
/// </summary>
public partial class App : Application
{
    private static readonly TimeSpan Twice = TimeSpan.FromMilliseconds(1500);

    private readonly string[] _args;
    private Board _board = null!;
    private Tray _tray = null!;
    private AppSettings _settings = null!;
    private DispatcherQueue _ui = null!;
    private DispatcherQueueTimer _hello = null!;
    private MainWindow? _window;
    private PillWindow? _pill;
    private SettingsWindow? _settingsWindow;
    private HashSet<string>? _waiting;
    private DateTime _hotkeyAt;
    private int _minutes;
    private string? _lang;
    private ElementTheme _theme;

    public App(string[] args)
    {
        _args = args;
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Write($"crash: {e.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, e) => Log.Write($"unobserved: {e.Exception}");
        UnhandledException += (_, e) => Log.Write($"ui: {e.Exception}");
        InitializeComponent();
        // Resident: closing the last window leaves the app in the tray.
        DispatcherShutdownMode = DispatcherShutdownMode.OnExplicitShutdown;
    }

    private Strings Words => Strings.For(_lang ?? _board.View?.Lang);

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _ui = DispatcherQueue.GetForCurrentThread();
        _settings = AppSettings.Load();
        _settings.ApplyStartAtLogin();
        _board = new Board(_ui);
        _board.Changed += OnBoard;

        _tray = new Tray(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"), "Kokuban");
        _tray.Clicked += () => OpenWindow("");
        _tray.Hotkey += OnHotkey;
        _tray.Menu = Menu;
        HoldHotkey();

        // Hello now and every minute: while the board hears it, it starts no other pill or banner.
        _hello = _ui.CreateTimer();
        _hello.Interval = TimeSpan.FromSeconds(60);
        _hello.Tick += (_, _) =>
        {
            _ = _board.Hello();
            // Another program (Explorer, for an old shortcut's hotkey) may let the key go later: ask again.
            if (!_hotkeyHeld) HoldHotkey();
            // Every half hour, a look at the board's feed for a newer version of the app.
            if (++_minutes % 30 == 1) _ = CheckForUpdate();
        };
        _hello.Start();
        _ = _board.Hello();

        // A later start with nothing asked of it is a hotkey press arriving through Explorer (its shortcut
        // holds the key while the app cannot) or the Start menu: the pill, or the window when nothing waits.
        Program.Handed += argv => _ui.TryEnqueue(() =>
        {
            if (argv.Length == 0) OnHotkey();
            else Handle(argv);
        });
        Handle(_args);
    }

    private bool _hotkeyHeld;

    /// <summary>Hold the hotkey (a demo copy never takes the person's); logged once while another program has it.</summary>
    private void HoldHotkey()
    {
        if (BoardClient.Demo) return;
        var was = _hotkeyHeld;
        _hotkeyHeld = _tray.HoldHotkey(_settings.HotkeyModifiers, _settings.HotkeyKey);
        if (_hotkeyHeld && !was && _minutes > 0) Log.Write($"hotkey {_settings.HotkeyName} held now");
        if (!_hotkeyHeld && _minutes == 0) Log.Write($"hotkey {_settings.HotkeyName} is held by another program; asking again every minute");
    }

    private void Handle(string[] argv)
    {
        string? Arg(string name)
        {
            var i = Array.IndexOf(argv, name);
            return i >= 0 && i + 1 < argv.Length ? argv[i + 1] : null;
        }
        if (Arg("--lang") is { } lang) _lang = lang;
        if (Arg("--theme") is { } theme) _theme = theme == "dark" ? ElementTheme.Dark : theme == "light" ? ElementTheme.Light : ElementTheme.Default;
        if (WindowPresentation.RejectPassiveView(argv, Environment.GetEnvironmentVariable("KOKUBAN_NOACTIVATE")))
        {
            Log.Write("--no-activate does not support --settings/--pill/--feed; no view was opened.");
            return;
        }
        if (argv.Contains("--quit")) Quit();
        else if (argv.Contains("--background")) { }
        else if (argv.Contains("--settings")) OpenSettings();
        else if (argv.Contains("--pill") || argv.Contains("--feed")) OnHotkey();
        else
        {
            OpenWindow(Arg("--item") ?? "", WindowPresentation.ShouldActivate(argv, Environment.GetEnvironmentVariable("KOKUBAN_NOACTIVATE")));
            if (argv.Contains("--usage")) _window?.ShowUsage();
        }
    }

    // -- the pill comes up by itself ------------------------------------------------------------------

    /// <summary>Something new waits on the person (a thread not waiting before): the pill, unless it is paused.</summary>
    private void OnBoard()
    {
        var view = _board.View;
        if (view is null) return;
        var mine = view.Mine.Select(i => i.Thread).ToHashSet();
        var fresh = _waiting is null ? mine.Count > 0 : mine.Except(_waiting).Any();
        _waiting = mine;
        var name = BoardClient.Demo ? $"Kokuban · Demo {BoardClient.Port}" : "Kokuban";
        _tray.SetTip(mine.Count > 0 ? $"{name} · {PillLayout.Build(view, 0, Words, 0).Label}" : name);
        if (fresh && !_settings.Paused) ShowPill();
    }

    private void ShowPill()
    {
        if (_pill is null)
        {
            _pill = new PillWindow(_board, OpenWindow);
            _pill.Closed += (_, _) =>
            {
                _pill = null;
                Settle();
            };
        }
        _pill.Present();
    }

    /// <summary>Once: the pill, or the window when nothing waits. Twice (or while the pill is up): the window.</summary>
    private void OnHotkey()
    {
        var again = DateTime.UtcNow - _hotkeyAt < Twice;
        _hotkeyAt = DateTime.UtcNow;
        if (again || _pill is not null)
        {
            var on = _pill?.CardThread ?? "";
            _pill?.Fold();
            OpenWindow(on);
            return;
        }
        if (_board.View?.Mine.Count > 0) ShowPill();
        else OpenWindow("");
    }

    // -- the window, settings, the tray ------------------------------------------------------------

    /// <summary>The window, on an item when one is given; one window, brought forward if open.</summary>
    private void OpenWindow(string item) => OpenWindow(item, true);

    private void OpenWindow(string item, bool activate)
    {
        var passive = !activate || Environment.GetEnvironmentVariable("KOKUBAN_NOACTIVATE") == "1";
        if (_window is null)
        {
            _window = new MainWindow(_board, item.Length > 0 ? item : null, _lang, _theme, allowInitialFocus: !passive && !Program.Offscreen);
            _window.Closed += (_, _) =>
            {
                _window = null;
                Settle();
            };
        }
        else if (item.Length > 0) _window.ShowItem(item);
        // KOKUBAN_NOACTIVATE=1 (checks driven by another program): show without taking the foreground.
        if (Program.Offscreen)
        {
            _window.AppWindow.Move(new Windows.Graphics.PointInt32(-20000, -20000));
            _window.ShowPassive();
        }
        else if (passive) _window.ShowPassive();
        else _window.Bring();
    }

    private void OpenSettings()
    {
        if (_settingsWindow is null)
        {
            _settingsWindow = new SettingsWindow(_settings, Words, (mods, key) => _hotkeyHeld = _tray.HoldHotkey(mods, key));
            _settingsWindow.Closed += (_, _) => _settingsWindow = null;
        }
        _settingsWindow.Activate();
    }

    private IReadOnlyList<Tray.Item?> Menu()
    {
        var t = Words;
        return
        [
            new(t.OpenApp, () => OpenWindow("")),
            _settings.Paused
                ? new(t.Resume, () => { _settings.PausedUntil = null; _settings.Save(); })
                : new(t.Pause, () => { _settings.PausedUntil = DateTimeOffset.Now.AddHours(1); _settings.Save(); _pill?.Fold(); }),
            new(t.Settings, OpenSettings),
            null,
            new(t.Quit, Quit),
        ];
    }

    private async Task CheckForUpdate()
    {
        if (await Updater.CheckAsync()) ApplyUpdateWhenIdle();
    }

    /// <summary>A downloaded update is applied only while nothing of the app is on screen; the app comes back in the tray.</summary>
    private void ApplyUpdateWhenIdle()
    {
        if (_window is not null || _pill is not null || _settingsWindow is not null) return;
        if (Updater.Apply()) Quit();
    }

    /// <summary>
    /// A window closed and the app goes back to waiting in the tray: give back what the window used, a
    /// few seconds later when its last frames are done.
    /// </summary>
    private void Settle()
    {
        var later = _ui.CreateTimer();
        later.Interval = TimeSpan.FromSeconds(3);
        later.IsRepeating = false;
        later.Tick += (_, _) =>
        {
            if (_window is not null || _pill is not null) return;
            ApplyUpdateWhenIdle();
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
            GC.Collect();
            Native.EmptyWorkingSet(System.Diagnostics.Process.GetCurrentProcess().Handle);
        };
        later.Start();
    }

    private void Quit()
    {
        _hello.Stop();
        _tray.Dispose();
        _pill?.Close();
        _window?.Close();
        _settingsWindow?.Close();
        _ = _board.DisposeAsync().AsTask().ContinueWith(_ => _ui.TryEnqueue(Exit), TaskScheduler.Default);
    }
}
