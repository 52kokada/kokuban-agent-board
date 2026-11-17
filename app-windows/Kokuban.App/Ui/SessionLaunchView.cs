using Kokuban.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Kokuban.App.Ui;

/// <summary>Human-controlled session starts and exact-history resumes on this PC.</summary>
public sealed class SessionLaunchView : UserControl, IDisposable
{
    private readonly BoardClient _client = new();
    private readonly ComboBox _target = new() { MinWidth = 170 };
    private readonly ComboBox _host = new() { MinWidth = 110 };
    private readonly TextBox _cwd = new() { PlaceholderText = "作業フォルダーのフルパス", Text = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) };
    private readonly TextBox _search = new() { PlaceholderText = "名前・AI・フォルダーで絞り込む" };
    private readonly ListView _sessions = new() { SelectionMode = ListViewSelectionMode.Single };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap };
    private readonly Button _resume = new() { Content = "選んだ会話を再開", IsEnabled = false };
    private readonly Button _create = new() { Content = "新しく起動" };
    private readonly Button _reset = new() { Content = "起動要求を解除", IsEnabled = false };
    private readonly Button _refresh = new() { Content = "更新" };
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer _timer;
    private List<LaunchSession> _all = [];
    private List<string> _targets = [];
    private bool _busy, _refreshing, _visible;
    private CancellationTokenSource? _requests;
    public Action? Back { get; set; }

    public SessionLaunchView()
    {
        foreach (var host in new[] { "Codex", "Claude", "Kimi" }) _host.Items.Add(host);
        _host.SelectedIndex = 0;
        var root = new Grid { Padding = new Thickness(24, 16, 24, 18), RowSpacing = 14 };
        foreach (var size in new[] { GridLength.Auto, GridLength.Auto, GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto }) root.RowDefinitions.Add(new RowDefinition { Height = size });
        var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 18 };
        var back = new Button { Content = "← 黒板へ" }; back.Click += (_, _) => Back?.Invoke();
        header.Children.Add(back); header.Children.Add(new TextBlock { Text = "セッションを起動・再開", FontSize = 23 }); root.Children.Add(header);
        var start = new StackPanel { Spacing = 9 };
        var options = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
        options.Children.Add(new TextBlock { Text = "開く場所", VerticalAlignment = VerticalAlignment.Center }); options.Children.Add(_target);
        options.Children.Add(_host); options.Children.Add(_create); start.Children.Add(options); start.Children.Add(_cwd);
        Grid.SetRow(start, 1); root.Children.Add(start);
        var filter = new Grid { ColumnSpacing = 12 };
        filter.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); filter.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        filter.Children.Add(_search); Grid.SetColumn(_refresh, 1); filter.Children.Add(_refresh); Grid.SetRow(filter, 2); root.Children.Add(filter);
        Grid.SetRow(_sessions, 3); root.Children.Add(_sessions);
        var footer = new StackPanel { Spacing = 10 }; var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
        actions.Children.Add(_resume); actions.Children.Add(_reset); footer.Children.Add(actions); footer.Children.Add(_status); Grid.SetRow(footer, 4); root.Children.Add(footer);
        Content = root;
        AutomationProperties.SetName(_target, "セッションを開く場所"); AutomationProperties.SetName(_host, "起動するAI");
        AutomationProperties.SetName(_cwd, "作業フォルダー"); AutomationProperties.SetName(_sessions, "このPCのセッション履歴");
        _search.TextChanged += (_, _) => Render();
        _sessions.SelectionChanged += (_, _) => Controls();
        _create.Click += async (_, _) => await Launch(false);
        _resume.Click += async (_, _) => await Launch(true);
        _reset.Click += async (_, _) => await Reset();
        _refresh.Click += async (_, _) => await Refresh();
        _timer = DispatcherQueue.CreateTimer(); _timer.Interval = TimeSpan.FromSeconds(10); _timer.Tick += async (_, _) => await Refresh();
    }
    private LaunchSession? Selected => (_sessions.SelectedItem as ListViewItem)?.Tag as LaunchSession;
    public void Start() { if (_visible) return; _visible = true; _requests = new(); Controls(); _timer.Start(); _ = Refresh(); }
    public void Stop() { _visible = false; _timer.Stop(); _requests?.Cancel(); _requests?.Dispose(); _requests = null; }
    public void Dispose() { Stop(); _client.Dispose(); }
    private async Task Refresh()
    {
        if (_refreshing || !_visible || _requests is null) return; _refreshing = true; var generation = _requests; var ct = generation.Token;
        try
        {
            var catalog = await _client.SessionsAsync(ct); if (_requests != generation || !_visible) return;
            _all = catalog.Sessions;
            var selected = _target.SelectedIndex >= 0 ? _targets.ElementAtOrDefault(_target.SelectedIndex) : null;
            _targets = (catalog.Targets ?? []).Where(t => t is "vscode" or "terminal").Distinct().ToList();
            _target.Items.Clear();
            foreach (var target in _targets) _target.Items.Add(target == "vscode" ? "VS Codeのタブ" : "Windows Terminal");
            _target.SelectedIndex = _targets.Count == 0 ? -1 : Math.Max(0, _targets.IndexOf(selected ?? ""));
            if (_targets.Count == 0) _status.Text = "外部セッション連携は未接続です。既存のAgents画面を利用できます。";
            Render();
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception e) when (e is BoardException or HttpRequestException) { if (_requests == generation && _visible) _status.Text = "履歴を取得できません。" + e.Message; }
        finally { _refreshing = false; }
    }
    private void Render()
    {
        var id = Selected?.Id; var search = _search.Text.Trim(); _sessions.Items.Clear();
        foreach (var s in _all.Where(s => search.Length == 0 || $"{s.Name} {s.Host} {s.Cwd}".Contains(search, StringComparison.OrdinalIgnoreCase)))
        {
            var body = new StackPanel { Spacing = 3, Margin = new Thickness(0, 5, 0, 5) };
            body.Children.Add(new TextBlock { Text = $"{s.Name} · {s.Host} · {(s.Live ? "接続中" : s.CanResume ? "再開できます" : s.Reason)}", FontSize = 14 });
            body.Children.Add(new TextBlock { Text = s.Cwd, FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis });
            body.Children.Add(new TextBlock { Text = s.Id, FontSize = 10, Opacity = 0.6 });
            var row = new ListViewItem { Content = body, Tag = s, HorizontalContentAlignment = HorizontalAlignment.Stretch };
            _sessions.Items.Add(row); if (s.Id == id) _sessions.SelectedItem = row;
        }
        Controls();
    }
    private void Controls()
    {
        _create.IsEnabled = _target.IsEnabled = _host.IsEnabled = _cwd.IsEnabled = !_busy && _targets.Count > 0;
        _resume.IsEnabled = !_busy && _targets.Count > 0 && Selected?.CanResume == true;
        _reset.IsEnabled = !_busy && Selected?.Pending == true;
    }
    private async Task Reset()
    {
        var selected = Selected; var generation = _requests;
        if (_busy || selected?.Pending != true || generation is null) return;
        var ct = generation.Token;
        _busy = true; Controls();
        try
        {
            var dialog = new ContentDialog { XamlRoot = XamlRoot, Title = "起動要求を解除しますか？",
                Content = "すでに開いたターミナルの状態を確認してください。要求だけを解除し、ターミナルや会話履歴は閉じたり削除したりしません。解除後に再開すると、すでに起動中の会話と重複する可能性があります。",
                PrimaryButtonText = "確認して解除", CloseButtonText = "戻る", DefaultButton = ContentDialogButton.Close };
            var choice = await dialog.ShowAsync();
            if (choice != ContentDialogResult.Primary || _requests != generation || !_visible) return;
            var result = await _client.ResetSessionLaunchAsync(selected.Id, ct);
            if (_requests == generation && _visible) _status.Text = result.Ok ? result.Done : result.Error;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception e) { if (_requests == generation && _visible) _status.Text = "起動要求を解除できませんでした。" + e.Message; }
        finally { _busy = false; if (_visible) Controls(); }
        await Refresh();
    }
    private async Task Launch(bool resume)
    {
        if (_busy || _requests is null || _target.SelectedIndex < 0) return; var selected = Selected; if (resume && selected?.CanResume != true) return; var generation = _requests; var ct = generation.Token;
        var target = _targets.ElementAtOrDefault(_target.SelectedIndex); if (target is null) return;
        _busy = true; Controls();
        _status.Text = "起動を要求しています…";
        try
        {
            var result = await _client.LaunchSessionAsync(target,
                resume ? selected!.Id : "", ((string)_host.SelectedItem).ToLowerInvariant(), _cwd.Text.Trim(), ct);
            if (_requests == generation && _visible) _status.Text = result.Ok ? result.Done : result.Error;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception e) when (e is BoardException or HttpRequestException) { if (_requests == generation && _visible) _status.Text = "起動を要求できませんでした。" + e.Message; }
        finally { _busy = false; if (_visible) Controls(); }
    }
}
