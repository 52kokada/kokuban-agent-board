using Kokuban.App.Ui;
using Kokuban.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using WinUIEx;

namespace Kokuban.App;

/// <summary>
/// The pill (decisions 9 to 11): a transparent, always-on-top window at the top centre of the
/// monitor the pointer is on, shown only while something waits on the person. It is click-through
/// everywhere but the island; near the island it fades so what is under it stays usable. A click
/// grows it into the card flow; ↗ steps into the window on that item. It closes itself when the
/// last item is cleared.
/// </summary>
public sealed class PillWindow : Window
{
    /// <summary>The window's size in DIPs, as the Electron pill had it: room for the card and its shadow.</summary>
    private const int W = 500, H = 330;

    private readonly Board _board;
    private readonly Action<string> _openWindow;
    private readonly Island _island = new() { Margin = new Thickness(0, 6, 0, 0) };
    private readonly Grid _pill = new() { Width = 250, Height = 36, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top };
    private readonly Grid _banner = new() { Width = 380, Height = 64, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Top };
    private readonly Grid _panel = new() { Padding = new Thickness(20, 18, 20, 16) };
    private readonly Dictionary<string, string> _errors = [];
    private readonly DispatcherQueueTimer _pointer;
    private readonly DispatcherQueueTimer _pingEnd;
    private readonly nint _hwnd;
    private readonly Native.SubclassProc? _placementGuard;

    // the pill
    private readonly StackPanel _pillDots = new() { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _pillLabel = new() { FontSize = 12, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
    private readonly Button _pillButton = new() { Padding = new Thickness(0), Background = null, BorderThickness = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    // the banner
    private readonly TextBlock _bannerWho = new() { FontSize = 12 };
    private readonly TextBlock _bannerQ = new() { FontSize = 14, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Button _bannerButton = new() { Style = (Style)Application.Current.Resources["RowButton"], CornerRadius = new CornerRadius(26) };
    private readonly Ellipse _bannerDot = new() { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center };
    // the card
    private readonly Ellipse _cardDot = new() { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _cardKind = new() { FontSize = 12, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _cardSource = new() { FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _cardTag = new() { FontSize = 12, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _cardTitle = new() { FontSize = 16, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, LineHeight = 21.6, LineStackingStrategy = LineStackingStrategy.BlockLineHeight, FontFamily = Theme.Display };
    private readonly TextBlock _cardBody = new() { FontSize = 14, TextWrapping = TextWrapping.Wrap, LineHeight = 20.3, LineStackingStrategy = LineStackingStrategy.BlockLineHeight };
    private readonly ActionsBar _actions = new();
    private readonly Grid _card = new() { RowSpacing = 8, Margin = new Thickness(0, 12, 0, 0) };
    private readonly StackPanel _pager = new() { Orientation = Orientation.Horizontal, Spacing = 4, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 10, 0, 0) };
    private Button _prev = null!, _next = null!, _toWindow = null!, _shut = null!;
    private readonly StackPanel _pips = new() { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };

    private int _index;
    private bool _presented;
    private Mutex? _one;
    private int _pillCount;
    private bool _open;
    private bool _ping;
    private bool _clickable;
    private bool _gone;
    private HashSet<string>? _known;
    private string _cardThread = "";

    public PillWindow(Board board, Action<string> openWindow)
    {
        _board = board;
        _openWindow = openWindow;
        Title = "Kokuban";
        SystemBackdrop = new TransparentTintBackdrop();
        _hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        // Only a PC that opted into a restricted pill monitor subclasses the window.
        if (Native.RestrictPillToMonitor) _placementGuard = Native.GuardPill(_hwnd);

        var presenter = OverlappedPresenter.CreateForContextMenu();
        presenter.IsAlwaysOnTop = true;
        presenter.SetBorderAndTitleBar(false, false);
        AppWindow.SetPresenter(presenter);
        // No frame at all: the presenter leaves WS_BORDER on, which draws a thin outline round the whole window.
        Native.SetStyle(_hwnd, 0, Native.WS_BORDER | Native.WS_DLGFRAME | Native.WS_THICKFRAME | Native.WS_CAPTION);
        Native.SetWindowPos(_hwnd, 0, 0, 0, 0, 0, 0x1 | 0x2 | 0x4 | 0x10 | 0x20 /* no size, move, z-order, activate; frame changed */);
        var test = Test;
        AppWindow.IsShownInSwitchers = test;
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));
        var none = Native.DWMWCP_DONOTROUND;
        Native.DwmSetWindowAttribute(_hwnd, Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref none, sizeof(int));
        var noBorder = Native.DWMWA_COLOR_NONE;
        Native.DwmSetWindowAttribute(_hwnd, Native.DWMWA_BORDER_COLOR, ref noBorder, sizeof(int));
        // Click-through until the pointer is on the island (layered + transparent, alpha kept at full).
        Native.SetExStyle(_hwnd, Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT | (test ? 0 : Native.WS_EX_TOOLWINDOW), 0);
        Native.SetLayeredWindowAttributes(_hwnd, 0, 255, Native.LWA_ALPHA);

        BuildPill();
        BuildBanner();
        BuildPanel();
        foreach (var part in new UIElement[] { _pill, _banner, _panel })
            part.OpacityTransition = new ScalarTransition { Duration = TimeSpan.FromMilliseconds(200) };
        _island.Parts.Add(_pill);
        _island.Parts.Add(_banner);
        _island.Parts.Add(_panel);
        var root = new Grid { Background = null };
        root.Children.Add(_island);
        root.KeyDown += OnKey;
        root.PreviewKeyDown += (_, e) =>
        {
            // Catch Escape before a focused reply box can consume it.
            if (e.Key == Windows.System.VirtualKey.Escape)
            {
                e.Handled = true;
                Fold();
            }
            if (e.Key == Windows.System.VirtualKey.F7) e.Handled = true;
        };
        Content = root;
        ShowParts();
        // Moving onto a monitor of another scale makes Windows resize the window by the ratio of the two scales
        // (WM_DPICHANGED), which left it narrower than the card and cut the card's sides off: whenever the
        // scale or the size changes, it is sized again from the scale it is really drawn at.
        root.Loaded += (_, _) =>
        {
            root.XamlRoot.Changed += (r, _) => Fit(r.RasterizationScale);
            Fit(root.XamlRoot.RasterizationScale);
        };
        AppWindow.Changed += (_, e) =>
        {
            if (e.DidSizeChange && Content?.XamlRoot is { } r) Fit(r.RasterizationScale);
        };

        _pointer = DispatcherQueue.CreateTimer();
        _pointer.Interval = TimeSpan.FromMilliseconds(33);
        _pointer.Tick += (_, _) => FollowPointer();
        _pingEnd = DispatcherQueue.CreateTimer();
        _pingEnd.Interval = TimeSpan.FromMilliseconds(2800);
        _pingEnd.IsRepeating = false;
        _pingEnd.Tick += (_, _) =>
        {
            _ping = false;
            Render();
        };

        _board.Changed += Render;
        Closed += (_, _) =>
        {
            _one?.ReleaseMutex();
            _one?.Dispose();
            _pointer.Stop();
            _board.Changed -= Render;
        };
    }

    /// <summary>
    /// --pill-test (or KOKUBAN_PILL_TEST=1): an ordinary window, so a test driver can move it to its own
    /// desktop and act on it.
    /// </summary>
    public static bool Test { get; set; } = Environment.GetEnvironmentVariable("KOKUBAN_PILL_TEST") == "1";

    /// <summary>The card on show, for the hotkey's second press: the window opens on it.</summary>
    public string CardThread => _open ? _cardThread : "";

    /// <summary>Put the pill away now (paused, or the window took over).</summary>
    public void Fold()
    {
        if (_gone) return;
        _gone = true;
        _open = false;
        _ping = false;
        _pingEnd.Stop();
        _pointer.Stop();
        // A dismissed island must stop intercepting input even while its exit animates.
        Native.SetExStyle(_hwnd, Native.WS_EX_TRANSPARENT, 0);
        _island.IsHitTestVisible = false;
        _island.Morph(IslandShape.Hidden);
        var bye = DispatcherQueue.CreateTimer();
        bye.Interval = TimeSpan.FromMilliseconds(400);
        bye.IsRepeating = false;
        bye.Tick += (_, _) => Close();
        bye.Start();
    }

    /// <summary>
    /// Put the pill on the monitor the pointer is on, top centre, and show it if something waits. Once
    /// shown it stays where it is (decision 11); asked again, it only comes to the front.
    /// </summary>
    public void Present()
    {
        if (_presented)
        {
            Native.SetWindowPos(_hwnd, -1 /* HWND_TOPMOST */, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 /* no size, no move, no activate */);
            Render();
            return;
        }
        // One pill on screen for this person, ever: a second Kokuban (a test copy) leaves it to the first.
        _one = new Mutex(false, BoardClient.Demo ? $@"Local\Kokuban.Pill-{BoardClient.Port}" : @"Local\Kokuban.Pill");
        bool mine;
        try
        {
            mine = _one.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            mine = true;
        }
        if (!mine)
        {
            _one.Dispose();
            _one = null;
            Close();
            return;
        }
        _presented = true;
        if (Native.RestrictPillToMonitor)
        {
            _pointer.Start();
            Fit(0);
            Render();
            return;
        }
        Native.GetCursorPos(out var p);
        _area = DisplayArea.GetFromPoint(new Windows.Graphics.PointInt32(p.X, p.Y), DisplayAreaFallback.Nearest).WorkArea;
        Fit(Native.ScaleAt(new Native.Point { X = _area.X + _area.Width / 2, Y = _area.Y + 1 }));
        AppWindow.Show(false);
        Fit(Content.XamlRoot?.RasterizationScale ?? 0);
        _pointer.Start();
        Render();
    }

    private Windows.Graphics.RectInt32 _area;

    /// <summary>W×H DIPs at this scale, top centre of the work area; nothing happens when it already is.</summary>
    private void Fit(double scale)
    {
        if (_gone || !_presented) return;
        if (Native.RestrictPillToMonitor)
        {
            if (Native.PillWorkArea() is not { } safe) { AppWindow.Hide(); return; }
            _area = new(safe.Left, safe.Top, safe.Right - safe.Left, safe.Bottom - safe.Top);
            scale = Native.ScaleAt(new Native.Point { X = safe.Left + _area.Width / 2, Y = safe.Top + 1 });
        }
        if (scale <= 0) return;
        var (w, h) = ((int)Math.Round(W * scale), (int)Math.Round(H * scale));
        if (Native.RestrictPillToMonitor && (w > _area.Width || h > _area.Height)) { AppWindow.Hide(); return; }
        var at = Program.Offscreen ? new Windows.Graphics.RectInt32(-20000, -20000, w, h) : new Windows.Graphics.RectInt32(_area.X + (_area.Width - w) / 2, _area.Y, w, h);
        var now = AppWindow.Size;
        var pos = AppWindow.Position;
        if (now.Width != w || now.Height != h || pos.X != at.X || pos.Y != at.Y) AppWindow.MoveAndResize(at);
        if (Native.RestrictPillToMonitor && !Native.IsWindowVisible(_hwnd)) AppWindow.Show(false);
    }

    private Strings Words => Strings.For(_board.View?.Lang);

    private void Render()
    {
        if (_gone) return;
        var v = _board.View;
        if (v is null) return;
        var t = Words;
        // Typing a reply holds the card still.
        if (_open && _actions.Typing && v.Mine.Any(i => i.Thread == _cardThread)) return;
        // The card on show stays on show when something arrives before it; only once it is gone (done) does the
        // next one take its place.
        var still = v.Mine.FindIndex(i => i.Thread == _cardThread);
        if (still >= 0) _index = still;
        var p = PillLayout.Build(v, _index, t, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), _errors);
        if (p.Card is null)
        {
            // Nothing waits: the pill leaves, and the window closes once it has gone.
            Fold();
            return;
        }
        _index = p.Index;
        var threads = v.Mine.Select(i => i.Thread).ToHashSet();
        // Something new arrived (or the pill just appeared): the banner shows the newest for a moment.
        if (_known is null || threads.Except(_known).Any())
        {
            if (!_open)
            {
                _ping = true;
                _pingEnd.Stop();
                _pingEnd.Start();
            }
        }
        _known = threads;

        SyncDots(_pillDots, p.Kinds, 8);
        // A test board's pill says so, so made-up questions are never taken for real ones.
        var label = BoardClient.Demo ? $"Demo · {p.Label}" : p.Label;
        if (_pillLabel.Text != label)
        {
            var had = _pillCount;
            _pillLabel.Text = label;
            _pillCount = p.Count;
            if (had > 0 && had != p.Count) Motion.Roll(_pillLabel, p.Count > had);
        }
        AutomationProperties.SetName(_pillButton, label);

        _bannerWho.Text = $"{(BoardClient.Demo ? "Demo · " : "")}{p.Newest!.Agent} · {p.Newest.Pc}";
        _bannerQ.Text = p.Newest.Title;
        AutomationProperties.SetName(_bannerButton, $"{_bannerWho.Text}: {p.Newest.Title}");
        KindPaint.SetKind(_bannerDot, p.Newest.Kind);

        var x = p.Card!;
        KindPaint.SetKind(_cardDot, x.Kind);
        _cardKind.Text = t.Kind(x.Kind);
        _cardSource.Text = p.Source;
        _cardTag.Text = p.Detail!.Tag;
        _cardTag.Visibility = p.Detail.Tag.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        _cardTitle.Text = x.Title;
        _cardBody.Text = x.Body;
        _cardBody.Visibility = x.Body.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        _actions.Show(p.Detail!);
        _cardThread = x.Thread;
        AutomationProperties.SetName(_toWindow, t.Open);
        ToolTipService.SetToolTip(_toWindow, t.Open);
        AutomationProperties.SetName(_shut, t.Close);
        ToolTipService.SetToolTip(_shut, t.Close);
        AutomationProperties.SetName(_prev, t.Prev);
        AutomationProperties.SetName(_next, t.NextItem);
        _pager.Visibility = p.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
        _prev.IsEnabled = p.Index > 0;
        _next.IsEnabled = p.Index < p.Count - 1;
        SyncPips(v.Mine, p.Index);
        ShowParts();
    }

    private void ShowParts()
    {
        var shape = _gone ? IslandShape.Hidden : _open ? IslandShape.Card : _ping ? IslandShape.Banner : IslandShape.Pill;
        if (_board.View is not null) _island.Morph(shape);
        Part(_pill, shape == IslandShape.Pill);
        Part(_banner, shape == IslandShape.Banner);
        Part(_panel, shape == IslandShape.Card);
        if (Native.RevealPillOnHover) FollowPointer();
        else if (shape != IslandShape.Pill) _island.Fade(false);
    }

    /// <summary>Show one part of the island; the others fade, then leave the tree so Tab and screen readers skip them.</summary>
    private void Part(UIElement part, bool on)
    {
        part.IsHitTestVisible = on;
        if (on)
        {
            part.Visibility = Visibility.Visible;
            part.Opacity = 1;
            return;
        }
        if (part.Visibility == Visibility.Collapsed) return;
        part.Opacity = 0;
        var later = DispatcherQueue.CreateTimer();
        later.Interval = TimeSpan.FromMilliseconds(260);
        later.IsRepeating = false;
        later.Tick += (_, _) =>
        {
            if (!part.IsHitTestVisible) part.Visibility = Visibility.Collapsed;
        };
        later.Start();
    }

    // -- the pointer: click-through and the fade ---------------------------------------------------

    private void FollowPointer()
    {
        if (Native.RestrictPillToMonitor)
        {
            Fit(0);
            if (!Native.IsWindowVisible(_hwnd)) return;
        }
        if (_gone || !Native.GetCursorPos(out var p) || !Native.GetWindowRect(_hwnd, out var r)) return;
        var scale = (r.Right - r.Left) / (double)W;
        var (w, h, _) = Island.SizeOf(_island.Shape);
        // The island in screen pixels: centred, 6 px from the top.
        var left = r.Left + (W - w) / 2 * scale;
        var top = r.Top + 6 * scale;
        var inWindow = p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom;
        var on = p.X >= left && p.X <= left + w * scale && p.Y >= top && p.Y <= top + h * scale;
        var core = on && p.X >= left + 14 * scale && p.X <= left + (w - 14) * scale;
        if (on != _clickable)
        {
            _clickable = on;
            Native.SetExStyle(_hwnd, on ? 0 : Native.WS_EX_TRANSPARENT, on ? Native.WS_EX_TRANSPARENT : 0);
        }
        if (Native.RevealPillOnHover)
        {
            const double padding = 24;
            var near = p.X >= left - padding * scale && p.X <= left + (w + padding) * scale
                && p.Y >= top - padding * scale && p.Y <= top + (h + padding) * scale;
            _island.Fade(!PillVisibility.ShouldReveal(_open, near));
        }
        else if (_island.Shape == IslandShape.Pill) _island.Fade(inWindow && !core);
    }

    // -- what the person does -------------------------------------------------------------------------

    private void OpenCard()
    {
        _open = true;
        _ping = false;
        _pingEnd.Stop();
        ShowParts();
        Activate();
    }

    private void CloseCard()
    {
        _open = false;
        ShowParts();
    }

    private void Go(int to)
    {
        var n = _board.View?.Mine.Count ?? 0;
        to = Math.Clamp(to, 0, Math.Max(0, n - 1));
        if (to == _index) return;
        var back = to < _index;
        _index = to;
        _cardThread = _board.View!.Mine[to].Thread;
        Render();
        Motion.Swap(_card, fromLeft: back);
    }

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == Windows.System.VirtualKey.Escape)
        {
            e.Handled = true;
            Fold();
            return;
        }
        if (!_open || e.OriginalSource is TextBox) return;
        if (e.Key == Windows.System.VirtualKey.Right) Go(_index + 1);
        if (e.Key == Windows.System.VirtualKey.Left) Go(_index - 1);
    }

    private async Task<bool> Act(string thread, string action, string text)
    {
        // The card leaves while the board takes it; the next one slides in after.
        var leaving = action == "reply" && text.Length == 0 ? Task.CompletedTask : Motion.Leave(_card);
        var done = await _board.Act(thread, action, text);
        await leaving;
        if (done.Ok) _errors.Remove(thread);
        else _errors[thread] = done.Error ?? "";
        if (done.Ok && action == "later")
        {
            Fold();
            return true;
        }
        Render();
        if (_gone) return done.Ok;
        if (done.Ok) Motion.Swap(_card, fromLeft: false);
        else Motion.Return(_card);
        return done.Ok;
    }

    // -- building ---------------------------------------------------------------------------------------

    private void BuildPill()
    {
        var g = new Grid { Padding = new Thickness(14, 0, 14, 0), ColumnSpacing = 10 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(_pillLabel, 1);
        var chev = new FontIcon { Glyph = "", FontSize = 10, Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(128, 235, 235, 245)), VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(chev, 2);
        _pillLabel.Foreground = Theme.White;
        g.Children.Add(_pillDots);
        g.Children.Add(_pillLabel);
        g.Children.Add(chev);
        _pillButton.Content = g;
        _pillButton.Style = (Style)Application.Current.Resources["RowButton"];
        _pillButton.CornerRadius = new CornerRadius(18);
        _pillButton.Click += (_, _) => OpenCard();
        _pill.Children.Add(_pillButton);
    }

    private void BuildBanner()
    {
        var g = new Grid { Padding = new Thickness(18, 0, 18, 0), ColumnSpacing = 12 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var icon = new Image { Source = new BitmapImage(new Uri("ms-appx:///Assets/icon-64.png")), Width = 38, Height = 38, VerticalAlignment = VerticalAlignment.Center };
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        _bannerWho.Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(158, 235, 235, 245));
        _bannerQ.Foreground = Theme.White;
        text.Children.Add(_bannerWho);
        text.Children.Add(_bannerQ);
        Grid.SetColumn(text, 1);
        Grid.SetColumn(_bannerDot, 2);
        g.Children.Add(icon);
        g.Children.Add(text);
        g.Children.Add(_bannerDot);
        _bannerButton.Content = g;
        _bannerButton.Click += (_, _) => OpenCard();
        _banner.Children.Add(_bannerButton);
    }

    private void BuildPanel()
    {
        _panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _panel.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var top = new Grid { ColumnSpacing = 8 };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _cardKind.Foreground = Theme.White;
        _cardSource.Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(158, 235, 235, 245));
        Grid.SetColumn(_cardKind, 1);
        _cardTag.Foreground = KindPaint.BrushOf(Kinds.Blocked, ElementTheme.Dark);
        Grid.SetColumn(_cardTag, 2);
        Grid.SetColumn(_cardSource, 3);
        _toWindow = Circle("↗", () =>
        {
            var thread = _cardThread;
            CloseCard();
            _openWindow(thread);
        });
        _shut = Circle("×", Fold);
        var circles = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        circles.Children.Add(_toWindow);
        circles.Children.Add(_shut);
        Grid.SetColumn(circles, 4);
        top.Children.Add(_cardTag);
        top.Children.Add(_cardDot);
        top.Children.Add(_cardKind);
        top.Children.Add(_cardSource);
        top.Children.Add(circles);
        _panel.Children.Add(top);

        _card.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _card.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _cardTitle.Foreground = Theme.White;
        _cardBody.Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(158, 235, 235, 245));
        var words = new StackPanel { Spacing = 8 };
        words.Children.Add(_cardTitle);
        words.Children.Add(_cardBody);
        var scroll = new ScrollViewer
        {
            Content = words,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollMode = ScrollMode.Disabled,
        };
        // Long task text scrolls independently; dismissal and actions stay visible.
        _actions.VerticalAlignment = VerticalAlignment.Bottom;
        _actions.Acted = Act;
        Grid.SetRow(_actions, 1);
        _card.Children.Add(scroll);
        _card.Children.Add(_actions);
        Grid.SetRow(_card, 1);
        _panel.Children.Add(_card);

        _prev = Step("", -1);
        _next = Step("", 1);
        _pager.Children.Add(_prev);
        _pager.Children.Add(_pips);
        _pager.Children.Add(_next);
        Grid.SetRow(_pager, 2);
        _panel.Children.Add(_pager);
    }

    /// <summary>The web page's .circ: a plain character, white, in a 26 px circle of 12% white (22% on hover).</summary>
    private static Button Circle(string glyph, Action click)
    {
        var b = new Button
        {
            Style = (Style)Application.Current.Resources["PillButton"],
            Width = 26, Height = 26, MinWidth = 26, MinHeight = 26, Padding = new Thickness(0), CornerRadius = new CornerRadius(13),
            Background = new SolidColorBrush(Windows.UI.Color.FromArgb(31, 255, 255, 255)),
            Content = new TextBlock { Text = glyph, FontSize = 14, Foreground = Theme.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center },
        };
        b.Resources["Fill1"] = new SolidColorBrush(Windows.UI.Color.FromArgb(26, 255, 255, 255));
        b.Click += (_, _) => click();
        Motion.Pressable(b);
        return b;
    }

    private Button Step(string glyph, int by)
    {
        var b = new Button
        {
            Style = (Style)Application.Current.Resources["RowButton"],
            Width = 26, Height = 26, CornerRadius = new CornerRadius(13), HorizontalAlignment = HorizontalAlignment.Center,
            Content = new FontIcon { Glyph = glyph, FontSize = 11, Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(153, 235, 235, 245)) },
        };
        b.Click += (_, _) => Go(_index + by);
        Motion.Pressable(b);
        // At either end the arrow stays in place, faint, as on the web page.
        b.IsEnabledChanged += (_, _) => b.Opacity = b.IsEnabled ? 1 : 0.25;
        return b;
    }

    private static void SyncDots(StackPanel panel, IReadOnlyList<string> kinds, double size)
    {
        var key = string.Join(",", kinds);
        if ((string?)panel.Tag == key) return;
        panel.Tag = key;
        panel.Children.Clear();
        foreach (var k in kinds)
        {
            var dot = new Ellipse { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center };
            KindPaint.SetKind(dot, k);
            panel.Children.Add(dot);
        }
    }

    private void SyncPips(IReadOnlyList<Item> items, int at)
    {
        while (_pips.Children.Count > items.Count) _pips.Children.RemoveAt(_pips.Children.Count - 1);
        while (_pips.Children.Count < items.Count)
        {
            var n = _pips.Children.Count;
            var pip = new Button
            {
                Padding = new Thickness(5), Background = null, BorderThickness = new Thickness(0), MinWidth = 0, MinHeight = 0,
                Content = new Border { Height = 6, CornerRadius = new CornerRadius(3) },
            };
            pip.Click += (_, _) => Go(n);
            _pips.Children.Add(pip);
        }
        for (var i = 0; i < items.Count; i++)
        {
            var pip = (Button)_pips.Children[i];
            var dot = (Border)pip.Content;
            dot.Width = i == at ? 16 : 6;
            dot.Background = new SolidColorBrush(i == at ? Windows.UI.Color.FromArgb(255, 255, 255, 255) : Windows.UI.Color.FromArgb(64, 255, 255, 255));
            AutomationProperties.SetName(pip, items[i].Title);
            ToolTipService.SetToolTip(pip, items[i].Title);
        }
    }
}
