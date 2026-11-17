using Kokuban.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Kokuban.App.Ui;

/// <summary>The local usage dashboard, hosted inside the existing Kokuban window.</summary>
public sealed class UsageDashboardView : UserControl
{
    private readonly TextBlock _remaining = Text("—", 34, true);
    private readonly TextBlock _generation = Text("YouTubeからの情報待ち", 12);
    private readonly TextBlock _bonus = Text("—", 12);
    private readonly TextBlock _bank = Text("—", 12);
    private readonly TextBlock _tokens = Text("—", 28, true);
    private readonly TextBlock _hosts = Text("集計中…", 12);
    private readonly TextBlock _day = Text("", 11);
    private readonly TextBlock _active = Text("—", 28, true);
    private readonly TextBlock _metadata = Text("", 11);
    private readonly TextBlock _detail = Text("エージェントを選ぶと作業の詳細を表示します。", 12);
    private readonly ComboBox _filter = new() { Width = 180, HorizontalAlignment = HorizontalAlignment.Right };
    private readonly ListView _agents = new() { SelectionMode = ListViewSelectionMode.Single, HorizontalContentAlignment = HorizontalAlignment.Stretch };
    private readonly List<Border> _cards = [];
    private UsageMonitor? _monitor;
    private UsageSnapshot? _snapshot;
    private bool _rendering;
    private bool _playbackConfigured;
    private readonly Dictionary<string, AgentVisual> _rows = [];
    private sealed record AgentVisual(ListViewItem Item, TextBlock Name, TextBlock State, TextBlock Count, TextBlock Task);
    public Action? Back { get; set; }

    public UsageDashboardView()
    {
        var root = new Grid { Padding = new Thickness(24, 16, 24, 18), RowSpacing = 16 };
        foreach (var h in new[] { GridLength.Auto, GridLength.Auto, GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto })
            root.RowDefinitions.Add(new RowDefinition { Height = h });
        var header = new Grid();
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var back = new Button { Content = "← 黒板へ", Margin = new Thickness(0, 0, 18, 0), VerticalAlignment = VerticalAlignment.Center };
        back.Click += (_, _) => Back?.Invoke();
        header.Children.Add(back);
        var title = new StackPanel { Spacing = 3 };
        title.Children.Add(Text("トークン・発電", 23, true));
        title.Children.Add(Text("このPCの使用量と、エージェントの今。", 12));
        Grid.SetColumn(title, 1); header.Children.Add(title); root.Children.Add(header);

        var metrics = new Grid { ColumnSpacing = 14 };
        for (var n = 0; n < 3; n++) metrics.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var youtube = new StackPanel { Spacing = 5 };
        youtube.Children.Add(Text("YouTube · 今日使える", 12));
        youtube.Children.Add(_remaining); youtube.Children.Add(_generation); youtube.Children.Add(_bonus); youtube.Children.Add(_bank);
        AddCard(metrics, youtube, 0);
        var tokens = new StackPanel { Spacing = 5 };
        tokens.Children.Add(Text("今日のトークン使用量", 12)); tokens.Children.Add(_tokens); tokens.Children.Add(_day); tokens.Children.Add(_hosts);
        AddCard(metrics, tokens, 1);
        var active = new StackPanel { Spacing = 5 };
        active.Children.Add(Text("現在、稼働確認できたエージェント", 12)); active.Children.Add(_active);
        active.Children.Add(Text("Codex · オレンジ  /  Claude · 紫", 11));
        active.Children.Add(Text("基本30分 / 日 ＋ 100万トークンで30秒", 11));
        active.Children.Add(Text("発電分・未使用分は貯金できます。", 11));
        AddCard(metrics, active, 2);
        Grid.SetRow(metrics, 1); root.Children.Add(metrics);

        var listHead = new Grid();
        listHead.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        listHead.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        listHead.Children.Add(Text("エージェント別の今日の使用量", 15, true));
        _filter.Items.Add("今日 ＋ 接続中"); _filter.Items.Add("稼働中のみ"); _filter.SelectedIndex = 0;
        AutomationProperties.SetName(_filter, "エージェント表示");
        _filter.SelectionChanged += (_, _) => RenderAgents();
        Grid.SetColumn(_filter, 1); listHead.Children.Add(_filter);
        Grid.SetRow(listHead, 2); root.Children.Add(listHead);

        AutomationProperties.SetName(_agents, "トークンとエージェント一覧");
        _agents.SelectionChanged += (_, _) =>
        {
            if (_rendering) return;
            UpdateDetail();
        };
        Grid.SetRow(_agents, 3); root.Children.Add(_agents);
        var foot = new StackPanel { Spacing = 10 };
        _metadata.MaxLines = 2; _metadata.TextTrimming = TextTrimming.CharacterEllipsis;
        _detail.MaxHeight = 95; _detail.TextTrimming = TextTrimming.CharacterEllipsis;
        foot.Children.Add(_detail); foot.Children.Add(_metadata);
        Grid.SetRow(foot, 4); root.Children.Add(foot);
        Content = root;
        ActualThemeChanged += (_, _) => Paint();
        Loaded += (_, _) => Paint();
    }

    private static TextBlock Text(string value, double size, bool bold = false) => new()
    {
        Text = value, FontSize = size, TextWrapping = TextWrapping.Wrap,
        FontWeight = bold ? Microsoft.UI.Text.FontWeights.SemiBold : Microsoft.UI.Text.FontWeights.Normal,
    };

    private void AddCard(Grid grid, UIElement body, int column)
    {
        var card = new Border { Child = body, Padding = new Thickness(18), CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(0.5) };
        _cards.Add(card); Grid.SetColumn(card, column); grid.Children.Add(card);
    }

    private void Paint()
    {
        foreach (var card in _cards) { card.Background = Theme.Brush(this, "Fill1"); card.BorderBrush = Theme.Brush(this, "LineBrush"); }
    }

    public void Start()
    {
        if (_monitor is not null) return;
        var options = AppSettings.Load().LocalUi ?? new LocalUiOptions();
        var tools = options.UsageToolsDirectory;
        if (string.IsNullOrWhiteSpace(tools) || !Path.IsPathFullyQualified(tools)
            || !File.Exists(Path.Combine(tools, "today-usage.mjs")) || !File.Exists(Path.Combine(tools, "live-sessions.mjs")))
        {
            _snapshot = null;
            _tokens.Text = _active.Text = _remaining.Text = _bonus.Text = _bank.Text = "—";
            _day.Text = "";
            _agents.Items.Clear();
            _rows.Clear();
            _hosts.Text = "未接続";
            _generation.Text = "未接続";
            _metadata.Text = "このPCの利用状況収集器が設定されていません。";
            return;
        }
        _playbackConfigured = options.PlaybackUri() is not null;
        _monitor = new UsageMonitor(tools, string.IsNullOrWhiteSpace(options.NodeExecutable) ? "node" : options.NodeExecutable, options.PlaybackUri());
        _monitor.Changed += OnChanged;
        _monitor.Start();
        OnChanged();
    }

    public async Task StopAsync()
    {
        if (_monitor is null) return;
        var monitor = _monitor; _monitor = null;
        monitor.Changed -= OnChanged;
        await monitor.DisposeAsync();
    }

    private void OnChanged() => DispatcherQueue.TryEnqueue(() =>
    {
        if (_monitor is null) return;
        _snapshot = _monitor.Snapshot;
        var s = _snapshot;
        _remaining.Text = s.RemainingText;
        _generation.Text = _playbackConfigured ? s.PlaybackStatus : "未接続";
        _bonus.Text = $"今日つくった時間  {s.BonusText}";
        _bank.Text = $"貯金総額  {s.BankText}";
        _tokens.Text = s.TokenText; _hosts.Text = s.HostBreakdown;
        _day.Text = $"{s.Day}  0:00 ～ 現在";
        _active.Text = s.ActiveCount.ToString();
        _metadata.Text = s.Metadata;
        RenderAgents();
    });

    private void RenderAgents()
    {
        if (_snapshot is null) return;
        var selectedKey = (_agents.SelectedItem as ListViewItem)?.Tag is UsageAgent selected ? selected.Key : null;
        _rendering = true;
        try
        {
            var agents = _snapshot.Agents.Where(a => _filter.SelectedIndex == 1 ? a.Active : a.LivePresent || a.HasTodayUsage).ToArray();
            var wanted = agents.Select(a => a.Key).ToHashSet(StringComparer.Ordinal);
            foreach (var key in _rows.Keys.Where(k => !wanted.Contains(k)).ToArray())
            {
                _agents.Items.Remove(_rows[key].Item);
                _rows.Remove(key);
            }
            var index = 0;
            foreach (var a in agents)
            {
                if (!_rows.TryGetValue(a.Key, out var visual))
                {
                var grid = new Grid { Padding = new Thickness(8, 10, 8, 10), ColumnSpacing = 16 };
                foreach (var width in new[] { new GridLength(160), new GridLength(145), new GridLength(1, GridUnitType.Star) })
                    grid.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
                var identity = new StackPanel { Spacing = 4 };
                var name = Text(a.Name, 14, true);
                name.Foreground = a.Active ? ColorBrush(a.NameColor) : Theme.Brush(this, "Ink");
                var state = Text($"{a.Host} · {a.State}", 11);
                identity.Children.Add(name); identity.Children.Add(state); grid.Children.Add(identity);
                var count = Text(a.TokenText, 14, true); count.VerticalAlignment = VerticalAlignment.Center;
                Grid.SetColumn(count, 1); grid.Children.Add(count);
                var task = Text(a.Task, 12); task.MaxLines = 2; task.TextTrimming = TextTrimming.CharacterEllipsis; task.VerticalAlignment = VerticalAlignment.Center;
                Grid.SetColumn(task, 2); grid.Children.Add(task);
                var row = new ListViewItem { Content = grid, Tag = a, HorizontalContentAlignment = HorizontalAlignment.Stretch };
                visual = new AgentVisual(row, name, state, count, task);
                _rows[a.Key] = visual;
                }
                visual.Item.Tag = a;
                visual.Name.Text = a.Name;
                visual.Name.Foreground = a.Active ? ColorBrush(a.NameColor) : Theme.Brush(this, "Ink");
                visual.State.Text = $"{a.Host} · {a.State}";
                visual.Count.Text = a.TokenText;
                visual.Task.Text = a.Task;
                AutomationProperties.SetName(visual.Item, $"{a.Name} · {a.Host} · {a.State} · 今日 {a.TokenText}トークン · {a.Task}");
                var oldIndex = _agents.Items.IndexOf(visual.Item);
                if (oldIndex != index)
                {
                    if (oldIndex >= 0) _agents.Items.RemoveAt(oldIndex);
                    _agents.Items.Insert(index, visual.Item);
                }
                if (a.Key == selectedKey) _agents.SelectedItem = visual.Item;
                index++;
            }
        }
        finally { _rendering = false; }
        UpdateDetail();
    }

    private void UpdateDetail()
    {
        _detail.Text = _agents.SelectedItem is ListViewItem { Tag: UsageAgent a }
            ? $"{a.Name} · {a.Host} · {a.State}\n{a.Task}" + (string.IsNullOrWhiteSpace(a.Next) ? "" : $"\n次の一手: {a.Next}")
            : "エージェントを選ぶと作業の詳細を表示します。";
    }

    private static SolidColorBrush ColorBrush(string color) => new(Color.FromArgb(255,
        Convert.ToByte(color.Substring(1, 2), 16), Convert.ToByte(color.Substring(3, 2), 16), Convert.ToByte(color.Substring(5, 2), 16)));
}
