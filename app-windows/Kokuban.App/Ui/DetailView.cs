using Kokuban.Core;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Kokuban.App.Ui;

/// <summary>
/// The detail pane (the web page's .det): an item with its actions, reply box, files and "What
/// happened"; a session as glance shows it; or the empty state. Parts are kept and changed in place,
/// so the reply being typed and the button under the pointer survive every update.
/// </summary>
public sealed class DetailView : UserControl
{
    /// <summary>The person acted: thread, action, text. Answers whether the board took it.</summary>
    public Func<string, string, string, Task<bool>>? Acted
    {
        get => _actions.Acted;
        set => _actions.Acted = value;
    }

    private readonly StackPanel _item = new() { Spacing = 14 };
    private readonly StackPanel _session = new() { Spacing = 14 };
    private readonly DesktopActivityView _desktopActivity = new();
    public void SetDesktopAgent(string? agent) => _desktopActivity.SetAgent(agent);
    private readonly StackPanel _empty = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Spacing = 2 };
    private readonly Grid _root = new();

    // item
    private readonly Ellipse _kindDot = Dot(8);
    private readonly TextBlock _kindLabel = new() { FontSize = 12, FontWeight = FontWeights.SemiBold };
    private readonly TextBlock _meta = new() { FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly Border _tag = new() { CornerRadius = new CornerRadius(99), Padding = new Thickness(8, 1, 8, 1) };
    private readonly TextBlock _tagText = new() { FontSize = 12, FontWeight = FontWeights.SemiBold };
    private readonly TextBlock _title = new() { FontFamily = Theme.Display, FontSize = 24, FontWeight = FontWeights.Bold, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, LineHeight = 29 };
    private readonly TextBlock _body = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, LineHeight = 22 };
    private readonly ActionsBar _actions = new();
    private readonly TextBlock _filesLabel = Label();
    private readonly StackPanel _files = new() { Spacing = 6 };
    private readonly TextBlock _happenedLabel = Label();
    private readonly StackPanel _steps = new();

    // session
    private readonly Grid _avatar = new() { Width = 40, Height = 40 };
    private readonly Ellipse _avatarDisc = new();
    private readonly TextBlock _avatarLetter = new() { Foreground = Theme.White, FontWeight = FontWeights.Bold, FontSize = 14, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _name = new() { FontFamily = Theme.Display, FontSize = 24, FontWeight = FontWeights.Bold, IsTextSelectionEnabled = true };
    private readonly TextBlock _sessMeta = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly Ellipse _sessDot = Dot(8);
    private readonly TextBlock _status = new() { FontSize = 12 };
    private readonly (TextBlock Label, TextBlock Text)[] _fields = [(Label(), Body()), (Label(), Body()), (Label(), Body())];

    // empty
    private readonly TextBlock _emptyTitle = new() { FontSize = 16, FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly TextBlock _emptyText = new() { HorizontalAlignment = HorizontalAlignment.Center };

    private ItemDetail? _shownItem;
    private Detail? _detail;

    public DetailView()
    {
        var meta = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        _kindDot.VerticalAlignment = VerticalAlignment.Center;
        _tag.Child = _tagText;
        meta.Children.Add(_kindDot);
        meta.Children.Add(_kindLabel);
        meta.Children.Add(_meta);
        meta.Children.Add(_tag);
        _item.Children.Add(meta);
        _item.Children.Add(_title);
        _item.Children.Add(_body);


        _item.Children.Add(_actions);
        _item.Children.Add(_filesLabel);
        _item.Children.Add(_files);
        _item.Children.Add(_happenedLabel);
        _steps.BorderThickness = new Thickness(1.5, 0, 0, 0);
        _steps.Padding = new Thickness(14, 0, 0, 0);
        _steps.Margin = new Thickness(3, 0, 0, 0);
        _item.Children.Add(_steps);

        _avatar.Children.Add(_avatarDisc);
        _avatar.Children.Add(_avatarLetter);
        var who = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        who.Children.Add(_name);
        who.Children.Add(_sessMeta);
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
        head.Children.Add(_avatar);
        head.Children.Add(who);
        _session.Children.Add(head);
        var status = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        _sessDot.VerticalAlignment = VerticalAlignment.Center;
        status.Children.Add(_sessDot);
        status.Children.Add(_status);
        _session.Children.Add(status);
        _session.Children.Add(_desktopActivity);
        foreach (var (label, text) in _fields)
        {
            _session.Children.Add(label);
            _session.Children.Add(text);
        }

        _empty.Children.Add(_emptyTitle);
        _empty.Children.Add(_emptyText);

        _root.Children.Add(_item);
        _root.Children.Add(_session);
        _root.Children.Add(_empty);
        Content = _root;
        ActualThemeChanged += (_, _) => Paint(themeChanged: true);
        Show(null);
    }

    private static Ellipse Dot(double size) => new() { Width = size, Height = size };

    private static TextBlock Label() => new() { FontSize = 12, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 6, 0, -8) };

    private static TextBlock Body() => new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, LineHeight = 22 };

    /// <summary>The person opened the item's n-th file.</summary>
    public Action<string, int>? OpenFile { get; set; }

    /// <summary>The detail key on show, for the window's entrance motion.</summary>
    public string Key => _detail?.Key ?? "";

    public void Show(Detail? d)
    {
        Log.Trace($"detail {d?.Key}");
        var fresh = d?.Key != _detail?.Key;
        _detail = d;
        _item.Visibility = d is ItemDetail ? Visibility.Visible : Visibility.Collapsed;
        _session.Visibility = d is SessionDetail ? Visibility.Visible : Visibility.Collapsed;
        _empty.Visibility = d is EmptyDetail ? Visibility.Visible : Visibility.Collapsed;
        _root.VerticalAlignment = d is EmptyDetail ? VerticalAlignment.Stretch : VerticalAlignment.Top;
        switch (d)
        {
            case ItemDetail x: ShowItem(x); break;
            case SessionDetail s: ShowSession(s); break;
            case EmptyDetail e:
                _emptyTitle.Text = e.Title;
                _emptyText.Text = e.Text;
                _emptyText.Visibility = e.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
                break;
        }
        Paint();
        // Another item or session: the pane's parts rise in one after another (the transition panel).
        if (fresh)
        {
            Motion.Reset(_item);
            var i = 0;
            foreach (var part in Shown.Children.Where(c => c.Visibility == Visibility.Visible)) Motion.Enter(part, i++, rise: 8, ms: 420, stagger: 30);
        }
    }

    private StackPanel Shown => _detail switch
    {
        ItemDetail => _item,
        SessionDetail => _session,
        _ => _empty,
    };

    /// <summary>The item the person acted on leaves the pane with its line.</summary>
    public Task Leave() => _detail is ItemDetail ? Motion.Leave(_item) : Task.CompletedTask;

    /// <summary>Back in place, when the board refused or the item stays.</summary>
    public void Return()
    {
        if (_detail is ItemDetail) Motion.Return(_item);
    }

    private void ShowItem(ItemDetail x)
    {
        _shownItem = x;
        KindPaint.SetKind(_kindDot, x.Kind);
        _kindLabel.Text = x.KindLabel;
        _meta.Text = $"·  {x.Meta}";
        _tag.Visibility = x.Tag.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        _tagText.Text = x.Tag;
        _title.Text = x.Title;
        _body.Text = x.Body;
        _body.Visibility = x.Body.Length > 0 ? Visibility.Visible : Visibility.Collapsed;

        _actions.Show(x);

        _filesLabel.Text = x.FilesLabel;
        _filesLabel.Visibility = _files.Visibility = x.Files.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        SyncTexts(_files, x.Files, FileLine);
        _happenedLabel.Text = x.HappenedLabel;
        _happenedLabel.Visibility = _steps.Visibility = x.Steps.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        SyncTexts(_steps, x.Steps.Select(s => $"{s.Text}\u0001{s.Ago}\u0001{s.Last}").ToList(), StepLine);
    }

    private void ShowSession(SessionDetail s)
    {
        if (_name.Text != s.Name) _avatarDisc.Fill = new SolidColorBrush(KindPaint.PersonColor(s.Name));
        _avatarLetter.Text = s.Name.Length > 0 ? s.Name[..1] : "?";
        _name.Text = s.Name;
        _sessMeta.Text = s.Meta;
        KindPaint.SetKind(_sessDot, s.Kind);
        _status.Text = s.Status;
        (string, string)[] fields = [(s.DoingLabel, s.Doing), (s.NextLabel, s.Next), (s.HoldsLabel, s.Holds)];
        for (var i = 0; i < fields.Length; i++)
        {
            var (label, text) = fields[i];
            var shown = text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            _fields[i].Label.Text = label;
            _fields[i].Text.Text = text;
            _fields[i].Label.Visibility = _fields[i].Text.Visibility = shown;
        }
    }

    /// <summary>Keep a panel's lines as they are when their text did not change.</summary>
    private void SyncTexts(StackPanel panel, IReadOnlyList<string> texts, Func<string, FrameworkElement> make)
    {
        for (var i = 0; i < texts.Count; i++)
        {
            if (i < panel.Children.Count && (string)((FrameworkElement)panel.Children[i]).Tag == texts[i]) continue;
            var line = make(texts[i]);
            line.Tag = texts[i];
            if (i < panel.Children.Count) panel.Children[i] = line;
            else panel.Children.Add(line);
        }
        while (panel.Children.Count > texts.Count) panel.Children.RemoveAt(panel.Children.Count - 1);
    }

    private FrameworkElement FileLine(string name)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Padding = new Thickness(12, 8, 12, 8) };
        row.Children.Add(new Border { Width = 20, Height = 26, CornerRadius = new CornerRadius(4), Background = Theme.Brush(this, "Fill2") });
        row.Children.Add(new TextBlock { Text = name, FontSize = 12, VerticalAlignment = VerticalAlignment.Center, Foreground = Theme.Brush(this, "Ink") });
        var b = new Button
        {
            Style = (Style)Application.Current.Resources["RowButton"], CornerRadius = new CornerRadius(10),
            Background = Theme.Brush(this, "Fill1"), Content = row, HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        AutomationProperties.SetName(b, name);
        b.Click += (_, _) =>
        {
            if (_shownItem is not null) OpenFile?.Invoke(_shownItem.Thread, _files.Children.IndexOf(b));
        };
        return b;
    }

    private FrameworkElement StepLine(string packed)
    {
        var p = packed.Split('\u0001');
        var last = p[2] == "True";
        var text = new TextBlock { FontSize = 12, TextWrapping = TextWrapping.Wrap, LineHeight = 17, IsTextSelectionEnabled = true };
        text.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run { Text = p[0], FontWeight = last ? FontWeights.SemiBold : FontWeights.Normal, Foreground = Theme.Brush(this, last ? "Ink" : "Ink2") });
        text.Inlines.Add(new Microsoft.UI.Xaml.Documents.Run { Text = $"   {p[1]}", Foreground = Theme.Brush(this, "Ink3") });
        var dot = new Ellipse { Width = 7, Height = 7, Fill = Theme.Brush(this, "Ink3"), HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(-18.25, 6, 0, 0) };
        var g = new Grid { Padding = new Thickness(0, 4, 0, 4) };
        g.Children.Add(dot);
        g.Children.Add(text);
        return g;
    }

    private void Paint(bool themeChanged = false)
    {
        _kindLabel.Foreground = Theme.Brush(this, "Ink");
        _meta.Foreground = Theme.Brush(this, "Ink2");
        // The disagreement tag: the kind's red on a 16% tint of it.
        var red = KindPaint.ColorOf(Kinds.Blocked, ActualTheme);
        _tag.Background = new SolidColorBrush(Windows.UI.Color.FromArgb(41, red.R, red.G, red.B));
        _tagText.Foreground = KindPaint.BrushOf(Kinds.Blocked, ActualTheme);
        _title.Foreground = _body.Foreground = _name.Foreground = Theme.Brush(this, "Ink");
        _filesLabel.Foreground = _happenedLabel.Foreground = Theme.Brush(this, "Ink2");
        _steps.BorderBrush = Theme.Brush(this, "Fill2");
        _sessMeta.Foreground = _status.Foreground = Theme.Brush(this, "Ink2");
        foreach (var (label, text) in _fields)
        {
            label.Foreground = Theme.Brush(this, "Ink2");
            text.Foreground = Theme.Brush(this, "Ink");
        }
        _emptyTitle.Foreground = Theme.Brush(this, "Ink");
        _emptyText.Foreground = Theme.Brush(this, "Ink2");
        if (themeChanged)
        {
            // Lines drawn with the old theme's brushes: draw them again.
            foreach (var panel in new[] { _files, _steps })
            {
                var texts = panel.Children.Select(c => (string)((FrameworkElement)c).Tag).ToList();
                panel.Children.Clear();
                SyncTexts(panel, texts, panel == _files ? FileLine : StepLine);
            }
        }
    }
}
