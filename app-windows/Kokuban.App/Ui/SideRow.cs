using Kokuban.Core;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Kokuban.App.Ui;

/// <summary>
/// One line of the sidebar (the web page's .nav, .sh and the PC list): a section, a project with its
/// session dots and count, a session inside an open project, or another PC. Built once; a new entry
/// changes only what differs, so the line under the pointer keeps its hover.
/// </summary>
public sealed class SideRow : UserControl
{
    public static event Action<SideEntry>? Invoked;

    private readonly Button _button = new() { Style = (Style)Application.Current.Resources["RowButton"], CornerRadius = new CornerRadius(7) };
    private readonly Grid _inner = new() { ColumnSpacing = 8 };
    private readonly Border _lead = new() { VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _label = new() { TextTrimming = TextTrimming.CharacterEllipsis, TextWrapping = TextWrapping.NoWrap, VerticalAlignment = VerticalAlignment.Center };
    private readonly StackPanel _dots = new() { Orientation = Orientation.Horizontal, Spacing = 3, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _count = new() { FontSize = 12, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _header = new() { FontSize = 12, FontWeight = FontWeights.SemiBold, Margin = new Thickness(10, 16, 10, 4) };
    private readonly Grid _root = new();
    private SideEntry? _entry;
    private string _leadKey = "";
    private string _dotsKey = "";

    public SideRow()
    {
        _inner.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _inner.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        _inner.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(_label, 1);
        var right = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
        right.Children.Add(_dots);
        right.Children.Add(_count);
        Grid.SetColumn(right, 2);
        _inner.Children.Add(_lead);
        _inner.Children.Add(_label);
        _inner.Children.Add(right);
        _button.Content = _inner;
        _button.Click += (_, _) =>
        {
            if (_entry is { Type: not SideType.Pc and not SideType.Header }) Invoked?.Invoke(_entry);
        };
        _root.Children.Add(_button);
        _root.Children.Add(_header);
        Content = _root;
        ActualThemeChanged += (_, _) => Paint();
    }

    /// <summary>The line's surface, where the gliding highlight sits when it is selected.</summary>
    public FrameworkElement Surface => _button;

    public bool Selected => _entry?.Selected == true;

    public SideEntry? Entry
    {
        get => _entry;
        set
        {
            if (value is null || Equals(value, _entry)) return;
            var was = _entry;
            _entry = value;
            Log.Trace($"side {value.Key}");
            Apply(value, was);
        }
    }

    private void Apply(SideEntry e, SideEntry? was)
    {
        var header = e.Type == SideType.Header;
        _header.Visibility = header ? Visibility.Visible : Visibility.Collapsed;
        _button.Visibility = header ? Visibility.Collapsed : Visibility.Visible;
        if (header)
        {
            _header.Text = e.Label;
            Paint();
            return;
        }
        var small = e.Type is SideType.Session or SideType.Pc;
        _inner.Padding = e.Type switch
        {
            SideType.Session => new Thickness(30, 4, 10, 4),
            SideType.Pc => new Thickness(10, 4, 10, 4),
            _ => new Thickness(10, 6, 10, 6),
        };
        _label.FontSize = small ? 12 : 14;
        _label.Text = e.Label;
        _button.IsTabStop = e.Type != SideType.Pc;
        _button.IsHitTestVisible = true;
        AutomationProperties.SetName(_button, string.Join(", ", new[] { e.Label, e.Count, e.Note }.Where(s => s.Length > 0)));
        if (e.Type == SideType.Project) AutomationProperties.SetItemStatus(_button, e.Open ? "open" : "closed");
        ToolTipService.SetToolTip(_button, e.Tip.Length > 0 ? e.Tip : null);
        // A section has its count; a session or a PC its note (the PC it is on, "not answering").
        var count = e.Type is SideType.Session or SideType.Pc ? e.Note : e.Count;
        if (count != _count.Text)
        {
            var grew = int.TryParse(count, out var n) && int.TryParse(_count.Text, out var m) ? n > m : (bool?)null;
            _count.Text = count;
            if (grew is { } up && was is not null) Motion.Roll(_count, up);
        }

        var lead = e.Type switch
        {
            SideType.Nav => $"icon:{e.Icon}",
            SideType.Project => "chev",
            _ => $"dot:{e.Kind}",
        };
        if (lead != _leadKey)
        {
            _leadKey = lead;
            _lead.Child = e.Type switch
            {
                SideType.Nav => Theme.Icon(e.Icon),
                // The web page's ▶, turned a quarter when the project is open.
                SideType.Project => new TextBlock { Text = "▶", FontSize = 10, Width = 12, Height = 14, TextAlignment = TextAlignment.Center },
                _ => Dot(e.Kind, 8),
            };
        }
        // The chevron turns as its project opens and closes.
        if (_lead.Child is TextBlock chev && (was is null || was.Open != e.Open))
        {
            if (was is null) chev.Loaded += (_, _) => Motion.Turn(chev, _entry?.Open == true ? 90 : 0);
            else Motion.Turn(chev, e.Open ? 90 : 0);
        }
        if (e.Dots != _dotsKey)
        {
            _dotsKey = e.Dots;
            _dots.Children.Clear();
            foreach (var k in e.Dots.Split(',', StringSplitOptions.RemoveEmptyEntries)) _dots.Children.Add(Dot(k, 6));
        }
        Paint();
    }

    private static Ellipse Dot(string kind, double size)
    {
        var dot = new Ellipse { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center };
        KindPaint.SetKind(dot, kind);
        return dot;
    }

    private void Paint()
    {
        _header.Foreground = Theme.Brush(this, "Ink3");
        _label.Foreground = Theme.Brush(this, "Ink");
        _count.Foreground = Theme.Brush(this, "Ink2");
        if (_lead.Child is TextBlock chev) chev.Foreground = Theme.Brush(this, "Ink3");
    }
}
