using Kokuban.App.Ui;
using Kokuban.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media.Animation;

namespace Kokuban.App;

/// <summary>
/// The window: all of kokuban for this PC's person (decision 12). The sidebar picks a section or a
/// project, the list shows what is in it, the detail shows one item or session. Every update goes
/// through Layout and is applied line by line, so nothing that did not change is drawn again.
/// </summary>
public sealed partial class MainWindow : Window
{
    private PhonePairingView? _phones;
    private async void OpenPhones(object sender, RoutedEventArgs e)
    {
        _phones ??= new PhonePairingView(Root);
        try { await _phones.Show(); } catch { /* Another modal can own the window; keep the board usable. */ }
    }
    private readonly Board _board;
    private readonly WindowState _state = new();
    private readonly Dictionary<string, string> _errors = [];
    private readonly DispatcherQueueTimer _clock;
    private readonly string? _langOverride;
    private ConversationView? _conversations;
    private SessionLaunchView? _sessionLaunch;
    private bool _passive;

    private void OpenAgents(object sender, RoutedEventArgs e)
    {
        HideSessionLaunch();
        HideUsage();
        if (_conversations is null)
        {
            try { _conversations = new ConversationView(_board); }
            catch (Exception error)
            {
                Log.Write($"conversation view: {error}");
                AgentDetail.Content = new Microsoft.UI.Xaml.Controls.TextBlock { Text = "Could not open agents. " + error.Message, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(28) };
                AgentDetail.Visibility = Visibility.Visible;
                return;
            }
            AgentList.Content = _conversations.SessionList; AgentDetail.Content = _conversations;
        }
        AgentList.Visibility = AgentDetail.Visibility = Visibility.Visible;
        ColScroll.Visibility = DetScroll.Visibility = Head.Visibility = Visibility.Collapsed;
        _ = _conversations.Attach();
        Motion.Enter(AgentList, 0, rise: 4, ms: 180);
    }
    private void HideAgents()
    {
        if (AgentDetail.Visibility != Visibility.Visible) return;
        _conversations?.Detach(); AgentList.Visibility = AgentDetail.Visibility = Visibility.Collapsed;
        ColScroll.Visibility = DetScroll.Visibility = Visibility.Visible;
    }

    public MainWindow(Board board, string? item = null, string? lang = null, ElementTheme theme = ElementTheme.Default, bool allowInitialFocus = true)
    {
        _board = board;
        _langOverride = lang;
        _state.Sel = item;
        InitializeComponent();
        ExtendsContentIntoTitleBar = true;
        if (BoardClient.Demo)
        {
            // A test board: made-up items, and the window says so in its name.
            Title = $"Kokuban · Demo {BoardClient.Port}";
            AppName.Text = Title;
        }
        SetTitleBar(TitleBar);
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1100, 720));
        Root.RequestedTheme = theme;
        Root.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, _) =>
        {
            if (_passive) Bring();
        }), true);

        // Lines that stay slide to their new places when others come or go (the space of a leaving item closes).
        Rows.ChildrenTransitions = [new RepositionThemeTransition { IsStaggeringEnabled = false }];
        Side.ChildrenTransitions = [new RepositionThemeTransition { IsStaggeringEnabled = false }];
        _sideGlide = new Glide(SideUnder, 7, shadow: false);
        _rowGlide = new Glide(RowsUnder, 8, shadow: false);
        Root.ActualThemeChanged += (_, _) => PaintGlides();
        PaintGlides();
        Root.SizeChanged += (_, _) => PlaceGlides();
        SideRow.Invoked += OnSide;
        ListRow.Invoked += OnRow;
        Detail.Acted = Act;
        Detail.OpenFile = (thread, n) => _ = OpenFile(thread, n);
        UsageView.Back = HideUsage;
        if (AppSettings.Load().LocalUi?.SessionLauncher == true)
        {
            SessionLaunchButton.Visibility = Visibility.Visible;
            SideHeadRow.Height = new GridLength(SideHeadRow.Height.Value + 34);
        }
        // The usage dashboard is a per-PC opt-in: without its collectors the sidebar stays as on main.
        if (!string.IsNullOrWhiteSpace(AppSettings.Load().LocalUi?.UsageToolsDirectory))
        {
            UsageButton.Visibility = Visibility.Visible;
            SideHeadRow.Height = new GridLength(SideHeadRow.Height.Value + 34);
        }

        _board.Changed += Render;
        // "2m" becomes "3m": the few lines that say how long ago something was are updated in place.
        _clock = DispatcherQueue.CreateTimer();
        _clock.Interval = TimeSpan.FromSeconds(30);
        _clock.Tick += (_, _) => Render();
        _clock.Start();
        Closed += (_, _) =>
        {
            _phones?.Dispose();
            _conversations?.Dispose();
            _sessionLaunch?.Dispose();
            _ = UsageView.StopAsync();
            _clock.Stop();
            _board.Changed -= Render;
            SideRow.Invoked -= OnSide;
            ListRow.Invoked -= OnRow;
        };
        Render();
        // Nothing has the keyboard at launch, so no focus ring sits on the first line; Tab starts from here.
        Detail.IsTabStop = true;
        if (allowInitialFocus) Root.Loaded += (_, _) => Detail.Focus(FocusState.Programmatic);
    }

    /// <summary>To the front, restored if it was minimized: the person asked for it.</summary>
    public void Bring()
    {
        _passive = false;
        Native.SetExStyle(WinRT.Interop.WindowNative.GetWindowHandle(this), 0, Native.WS_EX_NOACTIVATE);
        if (AppWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter { State: Microsoft.UI.Windowing.OverlappedPresenterState.Minimized } p) p.Restore();
        Activate();
        Native.SetForegroundWindow(WinRT.Interop.WindowNative.GetWindowHandle(this));
    }

    public void ShowPassive()
    {
        // A window the person already has open keeps its normal activation (and its taskbar/Alt+Tab entry).
        if (AppWindow.IsVisible && !_passive) return;
        _passive = true;
        Native.SetExStyle(WinRT.Interop.WindowNative.GetWindowHandle(this), Native.WS_EX_NOACTIVATE, 0);
        AppWindow.Show(false);
    }

    private void OnUsage(object sender, RoutedEventArgs e) => ShowUsage();
    public void ShowUsage()
    {
        HideSessionLaunch();
        HideAgents();
        NavigationPane.Visibility = ListPane.Visibility = DetScroll.Visibility = Visibility.Collapsed;
        UsageHost.Visibility = Visibility.Visible;
        UsageView.Start();
    }

    private void OnSessionLaunch(object sender, RoutedEventArgs e)
    {
        if (AppSettings.Load().LocalUi?.SessionLauncher != true) return;
        HideUsage(); HideAgents();
        _sessionLaunch ??= new SessionLaunchView { Back = HideSessionLaunch };
        SessionLaunchHost.Content = _sessionLaunch;
        NavigationPane.Visibility = ListPane.Visibility = DetScroll.Visibility = Visibility.Collapsed;
        SessionLaunchHost.Visibility = Visibility.Visible;
        _sessionLaunch.Start();
    }

    private void HideSessionLaunch()
    {
        if (SessionLaunchHost.Visibility != Visibility.Visible) return;
        _sessionLaunch?.Stop(); SessionLaunchHost.Visibility = Visibility.Collapsed;
        NavigationPane.Visibility = ListPane.Visibility = DetScroll.Visibility = Visibility.Visible;
    }

    private void HideUsage()
    {
        if (UsageHost.Visibility != Visibility.Visible) return;
        UsageHost.Visibility = Visibility.Collapsed;
        NavigationPane.Visibility = ListPane.Visibility = DetScroll.Visibility = Visibility.Visible;
        _ = UsageView.StopAsync();
    }

    /// <summary>Show one item, as the pill's ↗ asks.</summary>
    public void ShowItem(string thread)
    {
        HideSessionLaunch();
        HideUsage();
        HideAgents();
        _state.View = Section.You;
        _state.Sess = _state.Proj = _state.Person = null;
        _state.Sel = thread;
        Render();
    }

    private Strings Words => Strings.For(_langOverride ?? _board.View?.Lang);

    private void Render()
    {
        var t = Words;
        Problem.Text = _board.Connected ? "" : $"{t.NoBoard} {t.Retry}";
        Problem.Visibility = _board.Connected ? Visibility.Collapsed : Visibility.Visible;
        var v = _board.View;
        if (v is null) return;
        var l = Layout.Build(v, _state, t, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), _errors);
        Detail.SetDesktopAgent(l.Detail is SessionDetail ds && ds.Key == $"sess:{v.Pc}/{ds.Name}" ? ds.Name : null);
        var firstDraw = Side.Children.Count == 0;
        var sideMade = Keyed.Sync<SideEntry, SideRow>(Side, l.Side, e => e.Key, () => new SideRow(), (row, e) => row.Entry = e);
        Keyed.Sync<SideEntry, SideRow>(Pcs, l.Pcs, e => e.Key, () => new SideRow(), (row, e) => row.Entry = e);
        var rowsMade = Keyed.Sync<RowEntry, ListRow>(Rows, l.Rows, e => e.Key, () => new ListRow(), (row, e) => row.Entry = e);

        // A new view rises in line by line; in the same view, only what is new springs in.
        var viewKey = $"{_state.View}|{_state.Person}|{_state.Proj}|{(_state.Sess is not null && _state.Proj is null ? "sess" : "")}";
        if (viewKey != _viewKey)
        {
            var i = 0;
            foreach (var row in Rows.Children) Motion.Enter(row, i++);
        }
        else
        {
            foreach (var row in rowsMade.Where(r => r.Entry?.Type == RowType.Item)) Motion.Arrive(row);
        }
        _viewKey = viewKey;
        // A project opening: its sessions rise in under it.
        if (!firstDraw)
        {
            var j = 0;
            foreach (var row in sideMade.Where(r => r.Entry?.Type == SideType.Session)) Motion.Enter(row, j++, ms: 360);
        }
        Head.Visibility = l.Head is null ? Visibility.Collapsed : Visibility.Visible;
        if (l.Head is not null)
        {
            HeadTitle.Text = l.Head.Title;
            HeadNote.Text = l.Head.Note;
        }
        Detail.Visibility = l.Detail is null ? Visibility.Collapsed : Visibility.Visible;
        if (l.Detail is not null && l.Detail.Signature != _shownDetail)
        {
            _shownDetail = l.Detail.Signature;
            Detail.Show(l.Detail);
        }
        PlaceGlides();
        if (AgentDetail.Visibility == Visibility.Visible) Head.Visibility = Visibility.Collapsed;
    }

    private string _shownDetail = "";
    private string _viewKey = "";
    private readonly Glide _sideGlide;
    private readonly Glide _rowGlide;

    private void PaintGlides()
    {
        _sideGlide.Paint(((Microsoft.UI.Xaml.Media.SolidColorBrush)Theme.Brush(Root, "Fill2")).Color);
        _rowGlide.Paint(((Microsoft.UI.Xaml.Media.SolidColorBrush)Theme.Brush(Root, "Fill2")).Color);
    }

    /// <summary>The two highlights go to the selected lines, once layout has placed them.</summary>
    private void PlaceGlides()
    {
        Root.UpdateLayout();
        var side = Side.Children.OfType<SideRow>().FirstOrDefault(r => r.Selected);
        if (side is null) _sideGlide.Hide();
        else _sideGlide.MoveTo(Glide.Measure(side.Surface, SideUnder));
        var row = Rows.Children.OfType<ListRow>().FirstOrDefault(r => r.Selected);
        if (row is null) _rowGlide.Hide();
        else _rowGlide.MoveTo(Glide.Measure(row.Surface, RowsUnder));
    }

    private void OnSide(SideEntry e)
    {
        HideSessionLaunch();
        HideUsage();
        HideAgents();
        var key = e.Key;
        if (key.StartsWith("proj:", StringComparison.Ordinal))
        {
            var p = key[5..];
            var closing = _state.Open.Contains(p) && _state.Proj == p;
            _state.Proj = p;
            _state.Sess = null;
            if (closing)
            {
                // Its sessions fold away first; then they leave and the lines below slide up.
                var lines = Side.Children.OfType<SideRow>().SkipWhile(r => r.Entry?.Key != key).Skip(1)
                    .TakeWhile(r => r.Entry?.Type == SideType.Session).Cast<UIElement>().ToList();
                Render();
                _ = Motion.Fold(lines).ContinueWith(_ => DispatcherQueue.TryEnqueue(() =>
                {
                    _state.Open.Remove(p);
                    Render();
                }), TaskScheduler.Default);
                return;
            }
            _state.Open.Add(p);
        }
        else if (key.StartsWith("sess:", StringComparison.Ordinal))
        {
            _state.Sess = key[5..];
            _state.Proj = null;
        }
        else
        {
            _state.Sess = _state.Proj = _state.Person = null;
            _state.View = key switch
            {
                "nav:live" => Section.Live,
                "nav:hist" => Section.History,
                _ when key.StartsWith("nav:theirs:", StringComparison.Ordinal) => Section.Theirs,
                _ => Section.You,
            };
            if (_state.View == Section.Theirs) _state.Person = key["nav:theirs:".Length..];
        }
        Render();
    }

    private void OnRow(RowEntry e)
    {
        HideAgents();
        if (e.Key.StartsWith("item:", StringComparison.Ordinal)) _state.Sel = e.Key[5..];
        else if (e.Key.StartsWith("sess:", StringComparison.Ordinal))
        {
            _state.Sess = e.Key[5..];
            _state.Proj = null;
        }
        Render();
    }

    private async Task OpenFile(string thread, int n)
    {
        var v = _board.View;
        var item = v?.Mine.Concat(v.Later).Concat(v.Theirs.SelectMany(p => p.Items)).FirstOrDefault(i => i.Thread == thread);
        if (item is null || n < 0 || n >= item.Files.Count) return;
        var problem = await _board.OpenFile(item, n, Words);
        if (problem is null) _errors.Remove(thread);
        else _errors[thread] = problem;
        Render();
    }

    private async Task<bool> Act(string thread, string action, string text)
    {
        // What is done leaves on its way out, not after the board answers: the motion covers the round trip.
        var row = Rows.Children.OfType<ListRow>().FirstOrDefault(r => r.Entry?.Key == $"item:{thread}");
        var leaving = action == "reply" && text.Length == 0 ? Task.CompletedTask
            : Task.WhenAll(row is null ? Task.CompletedTask : Motion.Leave(row), Detail.Leave());
        var done = await _board.Act(thread, action, text);
        await leaving;
        if (done.Ok) _errors.Remove(thread);
        else _errors[thread] = done.Error ?? "";
        Render();
        // Still listed (refused, or moved to Later): it comes back where it now is.
        if (row is not null && Rows.Children.Contains(row)) Motion.Arrive(row);
        if (!done.Ok || Detail.Key == $"item:{thread}") Detail.Return();
        return done.Ok;
    }

    // F7 would offer caret browsing: not a thing this window has.
    private void OnPreviewKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == Windows.System.VirtualKey.F7) e.Handled = true;
    }

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        if (SessionLaunchHost.Visibility == Visibility.Visible && e.Key == Windows.System.VirtualKey.Escape)
        {
            HideSessionLaunch(); e.Handled = true; return;
        }
        if (UsageHost.Visibility == Visibility.Visible && e.Key == Windows.System.VirtualKey.Escape)
        {
            HideUsage();
            e.Handled = true;
            return;
        }
        if (e.Key == Windows.System.VirtualKey.Escape && e.OriginalSource is not Microsoft.UI.Xaml.Controls.TextBox) Close();
    }
}
