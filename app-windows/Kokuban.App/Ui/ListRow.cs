using Kokuban.Core;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Shapes;

namespace Kokuban.App.Ui;

/// <summary>
/// One line of the list column (the web page's .row, .grp and .empty): an item, a session, a running
/// hand-off or a line of history. Selection uses a quiet neutral surface.
/// </summary>
public sealed class ListRow : UserControl
{
    public static event Action<RowEntry>? Invoked;

    private readonly Button _button = new() { Style = (Style)Application.Current.Resources["RowButton"], CornerRadius = new CornerRadius(8), Margin = new Thickness(6, 0, 6, 0) };
    private readonly Ellipse _dot = new() { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 6, 0, 0) };
    private readonly TextBlock _top = new() { FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock _right = new() { FontSize = 12, HorizontalAlignment = HorizontalAlignment.Right };
    private readonly TextBlock _tag = new() { FontSize = 12, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 6, 0) };
    private readonly TextBlock _title = new() { FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock _sub = new() { FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock _group = new() { FontSize = 12, FontWeight = FontWeights.SemiBold, Margin = new Thickness(18, 12, 18, 4) };
    private readonly StackPanel _empty = new() { HorizontalAlignment = HorizontalAlignment.Center, Padding = new Thickness(0, 48, 0, 48), Spacing = 2 };
    private readonly TextBlock _emptyTitle = new() { FontSize = 16, FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly TextBlock _emptyText = new() { HorizontalAlignment = HorizontalAlignment.Center, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center };
    private RowEntry? _entry;

    public ListRow()
    {
        var top = new Grid { ColumnSpacing = 8 };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        // A disagreement says so before the age, in the kind's red.
        var right = new StackPanel { Orientation = Orientation.Horizontal };
        right.Children.Add(_tag);
        right.Children.Add(_right);
        Grid.SetColumn(right, 1);
        top.Children.Add(_top);
        top.Children.Add(right);
        var text = new StackPanel();
        text.Children.Add(top);
        text.Children.Add(_title);
        text.Children.Add(_sub);
        var inner = new Grid { ColumnSpacing = 10, Padding = new Thickness(12, 9, 12, 9) };
        inner.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        inner.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetColumn(text, 1);
        inner.Children.Add(_dot);
        inner.Children.Add(text);
        _button.Content = inner;
        _button.Click += (_, _) =>
        {
            if (_entry is { Type: RowType.Item or RowType.Session }) Invoked?.Invoke(_entry);
        };
        _empty.Children.Add(_emptyTitle);
        _empty.Children.Add(_emptyText);
        var root = new Grid();
        root.Children.Add(_button);
        root.Children.Add(_group);
        root.Children.Add(_empty);
        Content = root;
        ActualThemeChanged += (_, _) => Paint();
    }

    /// <summary>The line's surface, where the gliding highlight sits when it is selected.</summary>
    public FrameworkElement Surface => _button;

    public bool Selected => _entry?.Selected == true;

    public RowEntry? Entry
    {
        get => _entry;
        set
        {
            if (value is null || Equals(value, _entry)) return;
            _entry = value;
            Log.Trace($"row {value.Key}");
            Apply(value);
        }
    }

    private void Apply(RowEntry e)
    {
        var row = e.Type is not (RowType.Group or RowType.Empty);
        _button.Visibility = row ? Visibility.Visible : Visibility.Collapsed;
        _group.Visibility = e.Type == RowType.Group ? Visibility.Visible : Visibility.Collapsed;
        _empty.Visibility = e.Type == RowType.Empty ? Visibility.Visible : Visibility.Collapsed;
        if (e.Type == RowType.Group) _group.Text = e.Title;
        if (e.Type == RowType.Empty)
        {
            _emptyTitle.Text = e.Title;
            _emptyTitle.Visibility = e.Title.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            _emptyText.Text = e.Sub;
        }
        if (row)
        {
            KindPaint.SetKind(_dot, e.Kind);
            _top.Text = e.Top;
            _top.FontWeight = e.TopBold ? FontWeights.SemiBold : FontWeights.Normal;
            _right.Text = e.TopRight;
            _tag.Text = e.Tag;
            _tag.Visibility = e.Tag.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            _title.Text = e.Title;
            // A line of history is read whole; everything else is one line with an ellipsis.
            var whole = e.Type == RowType.History;
            _title.TextWrapping = whole ? TextWrapping.Wrap : TextWrapping.NoWrap;
            _title.TextTrimming = whole ? TextTrimming.None : TextTrimming.CharacterEllipsis;
            _title.FontWeight = whole ? FontWeights.Medium : FontWeights.SemiBold;
            _sub.Text = e.Sub;
            _sub.Visibility = e.Sub.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            _button.IsTabStop = e.Type is RowType.Item or RowType.Session;
            AutomationProperties.SetName(_button, string.Join(", ", new[] { e.Top, e.Title }.Where(s => s.Length > 0)));
            AutomationProperties.SetItemStatus(_button, e.Selected ? "selected" : "");
        }
        Paint();
    }

    private void Paint()
    {
        var sel = _entry?.Selected == true;
        _top.Foreground = sel || _entry?.TopBold == true ? Theme.Brush(this, "Ink") : Theme.Brush(this, "Ink2");
        _right.Foreground = Theme.Brush(this, "Ink2");
        _tag.Foreground = KindPaint.BrushOf(Kinds.Blocked, ActualTheme);
        _title.Foreground = Theme.Brush(this, "Ink");
        _sub.Foreground = Theme.Brush(this, "Ink2");
        _group.Foreground = Theme.Brush(this, "Ink3");
        _emptyTitle.Foreground = Theme.Brush(this, "Ink");
        _emptyText.Foreground = Theme.Brush(this, "Ink2");
        _dot.StrokeThickness = sel ? 1.5 : 0;
        _dot.Stroke = Theme.Brush(this, "Ink");
    }
}
