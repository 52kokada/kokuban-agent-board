using Kokuban.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Automation;

namespace Kokuban.App.Ui;

/// <summary>A quiet line in the agent's existing detail, visible only for recent local activity.</summary>
public sealed class DesktopActivityView : UserControl
{
    private readonly TextBlock _label = new() { FontSize = 13, TextWrapping = TextWrapping.Wrap };
    private readonly FontIcon _icon = new() { Glyph = "\uE7F4", FontSize = 16, VerticalAlignment = VerticalAlignment.Center };
    private readonly Border _surface;
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer _timer;
    private string? _agent;
    private bool _reading;
    private readonly bool _enabled = !string.IsNullOrWhiteSpace(AppSettings.Load().LocalUi?.DesktopActivityDirectory);
    public DesktopActivityView()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        row.Children.Add(_icon); row.Children.Add(_label);
        _surface = new Border { CornerRadius = new CornerRadius(10), Padding = new Thickness(12, 10, 12, 10), Child = row };
        Content = _surface;
        Visibility = Visibility.Collapsed;
        _timer = DispatcherQueue.CreateTimer();
        _timer.Interval = TimeSpan.FromSeconds(2);
        _timer.Tick += async (_, _) => await Refresh();
        // A per-PC opt-in: without a configured state directory the line never shows and nothing is polled.
        if (!_enabled) return;
        Loaded += async (_, _) => { _timer.Start(); await Refresh(); };
        Unloaded += (_, _) => _timer.Stop();
        ActualThemeChanged += (_, _) => Paint();
    }
    public void SetAgent(string? agent)
    {
        if (_agent == agent) return;
        _agent = agent; Visibility = Visibility.Collapsed;
        _ = Refresh();
    }
    private async Task Refresh()
    {
        if (!_enabled || _reading || _agent is null) return;
        _reading = true;
        var agent = _agent;
        try
        {
            var directory = AppSettings.Load().LocalUi?.DesktopActivityDirectory;
            var activity = await Task.Run(() => DesktopActivity.Read(agent, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), directory));
            if (_agent != agent) return;
            Visibility = Visibility.Visible;
            _label.Text = activity?.Label ?? "PC操作状況: 未接続";
            AutomationProperties.SetName(this, $"{agent}のPC操作: {_label.Text}");
            Paint();
        }
        finally { _reading = false; }
    }
    private void Paint()
    {
        _surface.Background = Theme.Brush(this, "Fill1");
        _label.Foreground = Theme.Brush(this, "Ink2");
        _icon.Foreground = new Microsoft.UI.Xaml.Media.SolidColorBrush(KindPaint.PersonColor(_agent ?? ""));
    }
}
