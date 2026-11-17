using Kokuban.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Kokuban.App.Ui;

/// <summary>
/// What the person can do with one of their items (the web page's acts()): the reply box, the
/// choices (the first one in its kind's colour), Later, and the board's words when it refused. Used
/// by the detail pane and by the pill's card. Buttons are kept by id, so the one under the pointer
/// stays put while the view updates.
/// </summary>
public sealed class ActionsBar : UserControl
{
    /// <summary>The person acted: thread, action, text. Answers whether the board took it.</summary>
    public Func<string, string, string, Task<bool>>? Acted { get; set; }

    private readonly Border _replyBox = new() { CornerRadius = new CornerRadius(17), Padding = new Thickness(14, 4, 4, 4) };
    private readonly TextBox _reply = new();
    private readonly Button _send = new() { Style = (Style)Application.Current.Resources["PillButton"], Width = 26, Height = 26, MinWidth = 26, MinHeight = 26, CornerRadius = new CornerRadius(13), Padding = new Thickness(0) };
    private readonly StackPanel _acts = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
    private readonly Button _later;
    private readonly TextBlock _error = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly Dictionary<string, (Button Button, Action<bool> Shine)> _buttons = [];
    private readonly Canvas _under = new();
    private Action<Windows.UI.Color?>? _glow;
    private Button? _glowFor;
    private Button? _main;
    private ItemDetail? _shown;

    public ActionsBar()
    {
        _reply.BorderThickness = new Thickness(0);
        _reply.Background = null;
        _reply.Padding = new Thickness(0, 4, 0, 4);
        _reply.MinHeight = 0;
        foreach (var key in new[] { "TextControlBackgroundPointerOver", "TextControlBackgroundFocused", "TextControlBorderBrushFocused", "TextControlBorderBrushPointerOver" })
            _reply.Resources[key] = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        _reply.KeyDown += (_, e) =>
        {
            if (e.Key != Windows.System.VirtualKey.Enter) return;
            e.Handled = true;
            SendReply();
        };
        _send.Content = new TextBlock { Text = "↑", FontSize = 14, Foreground = Theme.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        _send.Click += (_, _) => SendReply();
        var replyGrid = new Grid { ColumnSpacing = 6 };
        replyGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        replyGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(_send, 1);
        replyGrid.Children.Add(_reply);
        replyGrid.Children.Add(_send);
        _replyBox.Child = replyGrid;
        // Exactly round ends: a radius larger than half the height bends the ends out of shape.
        _replyBox.SizeChanged += (_, e) => _replyBox.CornerRadius = new CornerRadius(e.NewSize.Height / 2);

        _later = new Button { Style = (Style)Application.Current.Resources["PillButton"], Background = null, Padding = new Thickness(10, 7, 10, 7) };
        _later.Click += (_, _) => Act("later", "");
        Motion.Pressable(_later);
        Motion.Pressable(_send);

        // The reply box under the words, the actions at the foot (the pill's card stretches this; the
        // detail pane does not, and the rows simply stack).
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var row = new Grid { Margin = new Thickness(0, 12, 0, 0) };
        _error.Margin = new Thickness(0, 8, 0, 0);
        row.Children.Add(_under);
        row.Children.Add(_acts);
        Grid.SetRow(row, 2);
        Grid.SetRow(_error, 3);
        root.Children.Add(_replyBox);
        root.Children.Add(row);
        root.Children.Add(_error);
        Content = root;
        ActualThemeChanged += (_, _) => Paint();
    }

    /// <summary>Whether the reply box has the keyboard: the pill holds still while the person types.</summary>
    public bool Typing => _reply.FocusState != FocusState.Unfocused;

    public void Show(ItemDetail x)
    {
        if (_shown?.Thread != x.Thread) _reply.Text = "";
        _shown = x;
        _replyBox.Visibility = x.Reply ? Visibility.Visible : Visibility.Collapsed;
        _reply.PlaceholderText = x.ReplyHint;
        AutomationProperties.SetName(_reply, x.ReplyHint.TrimEnd('…'));
        AutomationProperties.SetName(_send, x.SendLabel);
        ToolTipService.SetToolTip(_send, x.SendLabel);
        // The send button is the accent, whatever the kind (the web page's --accent).
        KindPaint.SetKind(_send, "accent");

        var wanted = x.Choices.Select(c => c.Id).ToList();
        foreach (var gone in _buttons.Keys.Except(wanted).ToList())
        {
            _acts.Children.Remove(_buttons[gone].Button);
            _buttons.Remove(gone);
        }
        _acts.Children.Remove(_later);
        for (var i = 0; i < x.Choices.Count; i++)
        {
            var c = x.Choices[i];
            if (!_buttons.TryGetValue(c.Id, out var entry))
            {
                var id = c.Id;
                var made = new Button { Style = (Style)Application.Current.Resources["PillButton"] };
                Motion.Pressable(made);
                made.Click += (_, _) => Act(id, id.StartsWith("pick:", StringComparison.Ordinal) ? _reply.Text : "");
                entry = _buttons[c.Id] = (made, Shine.On(made));
            }
            var b = entry.Button;
            entry.Shine(c.Primary);
            if (c.Primary) _main = b;
            if (!Equals(b.Content, c.Label)) b.Content = c.Label;
            b.Tag = c.Primary ? x.Kind : null;
            if (_acts.Children.IndexOf(b) != i)
            {
                _acts.Children.Remove(b);
                _acts.Children.Insert(i, b);
            }
        }
        if (x.LaterLabel.Length > 0)
        {
            _later.Content = x.LaterLabel;
            _acts.Children.Add(_later);
        }
        _acts.Visibility = _acts.Children.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (!x.Choices.Any(c => c.Primary)) _main = null;
        _error.Text = x.Error;
        _error.Visibility = x.Error.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        Visibility = x.Mine ? Visibility.Visible : Visibility.Collapsed;
        Paint();
    }

    private void SendReply()
    {
        var words = _reply.Text.Trim();
        if (words.Length == 0)
        {
            _reply.Focus(FocusState.Programmatic);
            return;
        }
        Act("reply", words);
    }

    private async void Act(string action, string text)
    {
        if (_shown is null || Acted is null) return;
        var thread = _shown.Thread;
        // The words stay in the box until the board has taken them: a refusal leaves them to fix and send again.
        if (await Acted(thread, action, text) && _shown?.Thread == thread && text.Length > 0) _reply.Text = "";
    }

    private void Paint()
    {
        _replyBox.Background = Theme.Brush(this, "Fill1");
        // The placeholder is faint, as the web page's ::placeholder (--gink3).
        _reply.PlaceholderForeground = Theme.Brush(this, "Ink3");
        _error.Foreground = Theme.Brush(this, "Danger");
        _later.Foreground = Theme.Brush(this, "Ink2");
        // The main button's glow, in its kind's colour.
        if (_main is not null)
        {
            if (_glow is null || !ReferenceEquals(_glowFor, _main))
            {
                _under.Children.Clear();
                var layer = new Canvas();
                _under.Children.Add(layer);
                _glow = Shine.GlowUnder(layer, _main);
                _glowFor = _main;
            }
            _glow(KindPaint.ColorOf((string)_main.Tag, ActualTheme));
        }
        else _glow?.Invoke(null);
        foreach (var (b, _) in _buttons.Values)
        {
            if (b.Tag is string kind)
            {
                b.Background = KindPaint.BrushOf(kind, ActualTheme);
                b.Foreground = Theme.White;
            }
            else
            {
                b.Background = Theme.Brush(this, "Fill1");
                b.Foreground = Theme.Brush(this, "Ink");
            }
        }
    }
}
