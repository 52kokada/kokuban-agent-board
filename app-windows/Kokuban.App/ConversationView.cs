using Kokuban.App.Ui;
using Kokuban.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using System.Text.Json;

namespace Kokuban.App;

/// <summary>An embedded viewer. Leaving it cancels polling, never the host's agent.</summary>
public sealed class ConversationView : UserControl, IDisposable
{
    private readonly BoardClient _client = new();
    private readonly Board _board;
    private readonly ConversationOutbox _outbox;
    private readonly CancellationTokenSource _closed = new();
    private CancellationTokenSource? _reading;
    private readonly Grid _root = new() { Padding = new Thickness(28, 18, 28, 24) };
    public FrameworkElement SessionList { get; private set; } = null!;
    private readonly ListView _sessions = new() { SelectionMode = ListViewSelectionMode.Single };
    private readonly ListView _transcript = new() { SelectionMode = ListViewSelectionMode.None };
    private readonly ComboBox _pc = new() { MinWidth = 180, Header = "Host PC" };
    private readonly TextBlock _title = new() { FontSize = 22, FontFamily = Theme.Display };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock _problem = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly TextBox _composer = new() { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 72, MaxHeight = 180, PlaceholderText = "Message the agent…", MaxLength = ConversationRules.MessageBytes };
    private readonly TextBlock _limit = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12, Visibility = Visibility.Collapsed };
    private readonly StackPanel _approvals = new() { Spacing = 8 };
    private readonly StackPanel _queue = new() { Spacing = 4 };
    private readonly Button _send = new() { Content = "Send" };
    private readonly Button _stop = new() { Content = "Stop" };
    private readonly Button _resume = new() { Content = "Resume" };
    private readonly Button _shutdown = new() { Content = "Shut down" };
    private readonly Button _restart = new() { Content = "Restart" };
    private readonly Button _retry = new() { Content = "Retry delivery" };
    private Conversation? _selected;
    private long _cursor;
    private TextBlock? _assistant;
    // Opening shows the newest bounded page; older history loads only when asked (TranscriptWindow).
    private readonly TranscriptWindow<object> _window;
    private bool _opened, _loadingEarlier, _legacyHistory;
    /// <summary>Changes on every selection and every Latest reload, so a slower earlier answer cannot land in a newer view.</summary>
    private int _view;
    private readonly Button _earlier = new() { Content = "Load earlier", HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 4, 0, 8), Visibility = Visibility.Collapsed };
    private readonly Button _latest = new() { Content = "Latest messages", HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 8, 0, 4), Visibility = Visibility.Collapsed };
    private object? _pendingSend;
    private bool _sending;
    private string _controlSignature = "";
    private string _listSignature = "";
    private readonly Dictionary<string, Conversation> _known = [];
    /// <summary>Unsent text per conversation; switching between agents keeps each one.</summary>
    private readonly Dictionary<string, string> _drafts = [];
    // What the problem line shows. A command failure stays until a later command or retry resolves it;
    // polling only replaces the session and connection parts.
    private string? _commandError, _connectionError;
    /// <summary>The last list or catalog problem per host PC; only the chosen host's is shown, so switching hosts never leaves another PC's error behind.</summary>
    private readonly Dictionary<string, string> _hostErrors = [];
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer _refresh;

    public ConversationView(Board board)
    {
        _board = board;
        _window = new TranscriptWindow<object>(_transcript.Items, item => item is FrameworkElement { Tag: long seq } ? seq : 0);
        _outbox = new ConversationOutbox(BoardClient.Demo ? Path.Combine(Path.GetTempPath(), "kokuban-chat-outbox-" + BoardClient.Port) : null);
        var sidebar = new Grid { Padding = new Thickness(16, 16, 16, 12), RowSpacing = 16 };
        sidebar.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        sidebar.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        sidebar.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var top = new Grid(); top.ColumnDefinitions.Add(new ColumnDefinition()); top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.Children.Add(new TextBlock { Text = "Agents", FontSize = 20, FontFamily = Theme.Display, VerticalAlignment = VerticalAlignment.Center });
        var create = new Button { Content = "+", FontSize = 20, Padding = new Thickness(12, 3, 12, 3) };
        AutomationProperties.SetName(create, "New shared agent"); ToolTipService.SetToolTip(create, "New agent");
        create.Click += async (_, _) => await Launch(); Grid.SetColumn(create, 1); top.Children.Add(create);
        sidebar.Children.Add(top); Grid.SetRow(_pc, 1); sidebar.Children.Add(_pc);
        Grid.SetRow(_sessions, 2); sidebar.Children.Add(_sessions); SessionList = sidebar;
        _sessions.ItemContainerStyle = RowStyle("Fill1");
        _sessions.ItemTemplate = (DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load("<DataTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'><StackPanel Padding='12,10' Spacing='4'><TextBlock Text='{Binding Name}' FontSize='15' FontWeight='SemiBold'/><TextBlock FontSize='12' Opacity='.6'><Run Text='{Binding Project}'/><Run Text=' · '/><Run Text='{Binding Host}'/></TextBlock><TextBlock Text='{Binding Phase}' FontSize='11' Opacity='.6'/></StackPanel></DataTemplate>");
        var detail = new Grid { RowSpacing = 10 };
        foreach (var height in new[] { GridLength.Auto, GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto, GridLength.Auto, GridLength.Auto }) detail.RowDefinitions.Add(new RowDefinition { Height = height });
        var heading = new StackPanel { Spacing = 4 }; heading.Children.Add(_title); heading.Children.Add(_status); heading.Children.Add(_problem); detail.Children.Add(heading);
        var controls = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        foreach (var button in new[] { _stop, _resume, _shutdown, _restart, _retry }) controls.Children.Add(button);
        Grid.SetRow(controls, 1); detail.Children.Add(controls);
        // The history controls sit outside the list, so the list holds transcript entries only.
        var history = new Grid();
        foreach (var height in new[] { GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto }) history.RowDefinitions.Add(new RowDefinition { Height = height });
        history.Children.Add(_earlier); Grid.SetRow(_transcript, 1); history.Children.Add(_transcript); Grid.SetRow(_latest, 2); history.Children.Add(_latest);
        Grid.SetRow(history, 2); detail.Children.Add(history);
        Grid.SetRow(_approvals, 3); detail.Children.Add(_approvals);
        Grid.SetRow(_queue, 4); detail.Children.Add(_queue);
        var compose = new Grid { ColumnSpacing = 10 }; compose.ColumnDefinitions.Add(new ColumnDefinition()); compose.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var field = new StackPanel { Spacing = 4 }; field.Children.Add(_composer); field.Children.Add(_limit);
        compose.Children.Add(field); Grid.SetColumn(_send, 1); _send.VerticalAlignment = VerticalAlignment.Bottom; compose.Children.Add(_send);
        Grid.SetRow(compose, 5); detail.Children.Add(compose); _root.Children.Add(detail);
        Content = _root;
        _root.Loaded += (_, _) => { Paint(); Motion.Enter(_root, 0, rise: 4, ms: 180); };
        ActualThemeChanged += (_, _) => Paint();
        foreach (var button in new[] { create, _send, _stop, _resume, _shutdown, _restart, _retry }) StyleButton(button);
        _pc.Header = null; _pc.PlaceholderText = "Host PC"; _pc.HorizontalAlignment = HorizontalAlignment.Stretch;
        StyleField(_pc); AutomationProperties.SetName(_pc, "Host PC");
        _title.FontSize = 26; _status.FontSize = 12; _problem.FontSize = 12;
        _composer.BorderThickness = new Thickness(0); _composer.CornerRadius = new CornerRadius(14); _composer.Padding = new Thickness(14, 12, 14, 12);
        _composer.KeyDown += async (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter && Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Control).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down)) { e.Handled = true; await Send(); } };
        _composer.TextChanged += (_, _) => ShowLimit();
        ToolTipService.SetToolTip(_send, "Send · Ctrl+Enter");
        ToolTipService.SetToolTip(_stop, "Interrupt the current turn and hold the queue");
        ToolTipService.SetToolTip(_shutdown, "End the agent; keep the conversation");
        _transcript.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        // Prepending history must keep the current message in view rather than jump to the new first row.
        _transcript.ItemsPanel = (ItemsPanelTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load("<ItemsPanelTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'><ItemsStackPanel ItemsUpdatingScrollMode='KeepItemsInView'/></ItemsPanelTemplate>");
        _transcript.ItemContainerStyle = new Style(typeof(ListViewItem)) { Setters = { new Setter(Control.HorizontalContentAlignmentProperty, HorizontalAlignment.Stretch), new Setter(Control.PaddingProperty, new Thickness(0)), new Setter(UIElement.IsHitTestVisibleProperty, true) } };

        _refresh = DispatcherQueue.CreateTimer(); _refresh.Interval = TimeSpan.FromSeconds(30);
        _refresh.Tick += async (_, _) => await Refresh(); _refresh.Start();
        // Phase changes are announced once each; streamed text is not, so a reply is not read out token by token.
        AutomationProperties.SetLiveSetting(_status, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        AutomationProperties.SetName(_sessions, "Shared agent conversations"); AutomationProperties.SetName(_transcript, "Conversation history"); AutomationProperties.SetName(_composer, "Message the shared agent");
        _pc.Items.Add("local");
        foreach (var pc in board.View?.Pcs.Select(p => p.Pc).Distinct() ?? []) if (pc != board.View?.Pc) _pc.Items.Add(pc);
        _pc.SelectedIndex = 0;
        // The problem line follows the chosen host at once; the refresh then confirms it.
        _pc.SelectionChanged += async (_, _) => { ShowProblem(); await Refresh(); };
        _sessions.SelectionChanged += async (_, _) => { if (_sessions.SelectedItem is Conversation s) await Select(s); };
        _send.Click += async (_, _) => await Send();
        _stop.Click += async (_, _) => await Command("stop"); _resume.Click += async (_, _) => await Command("resume");
        _restart.Click += async (_, _) => await Command("restart"); _shutdown.Click += async (_, _) =>
        {
            if (_selected is null) return;
            var dialog = new ContentDialog { XamlRoot = _root.XamlRoot, Title = $"Shut down {_selected.Name}?", Content = "Ends the agent for everyone. History and queued messages stay.", PrimaryButtonText = "Shut down", CloseButtonText = "Cancel" };
            StyleDialog(dialog, "Danger");
            if (await dialog.ShowAsync() == ContentDialogResult.Primary) await Command("shutdown");
        };
        StyleButton(_earlier); AutomationProperties.SetName(_earlier, "Load earlier messages");
        _earlier.Click += async (_, _) => await LoadEarlier();
        StyleButton(_latest); AutomationProperties.SetName(_latest, "Show latest messages");
        ToolTipService.SetToolTip(_latest, "Earlier messages are shown. New output appears when you return to the latest.");
        _latest.Click += async (_, _) => { if (_selected is { } s) await ReturnToLatest(s); };
        _retry.Click += async (_, _) =>
        {
            if (_selected is not { } selected) return;
            try { foreach (var request in _outbox.Pending(selected.Host, selected.Id)) await Deliver(request);
                  // Everything pending was confirmed; a delivered message leaves the composer.
                  if (_pendingSend is not null) { _pendingSend = null; _composer.Text = ""; _drafts.Remove(selected.Id); }
                  _commandError = null; }
            catch (Exception e) when (e is BoardException or IOException or HttpRequestException or OperationCanceledException) { _commandError = e.Message; }
            ShowProblem(); SetControls();
        };
        _root.Loaded += async (_, _) => await Refresh();

        SetControls();
    }
    private static void StyleButton(Button button)
    {
        button.Style = (Style)Application.Current.Resources["PillButton"];
        Motion.Pressable(button);
    }
    private void StyleField(Control field)
    {
        field.CornerRadius = new CornerRadius(10); field.BorderThickness = new Thickness(0);
        field.Background = Theme.Brush(this, "Fill1"); field.Padding = new Thickness(12, 9, 12, 9);
        field.Resources["TextControlBorderThicknessFocused"] = new Thickness(0);
        field.Resources["TextControlBackgroundFocused"] = Theme.Brush(this, "Fill1");
        field.Resources["ComboBoxBackgroundPointerOver"] = Theme.Brush(this, "Fill2");
    }
    /// <summary>A rounded list row whose fill shows hover and selection, as in the sidebar.</summary>
    private static Style RowStyle(string fill)
    {
        var style = new Style(typeof(ListViewItem)) { Setters = { new Setter(Control.HorizontalContentAlignmentProperty, HorizontalAlignment.Stretch), new Setter(Control.PaddingProperty, new Thickness(0)), new Setter(Control.MarginProperty, new Thickness(0, 2, 0, 2)) } };
        style.Setters.Add(new Setter(Control.TemplateProperty, Microsoft.UI.Xaml.Markup.XamlReader.Load($"<ControlTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation' xmlns:x='http://schemas.microsoft.com/winfx/2006/xaml' TargetType='ListViewItem'><Grid Background='Transparent' CornerRadius='12'><Border x:Name='Fill' Background='{{ThemeResource {fill}}}' Opacity='0' CornerRadius='12'/><ContentPresenter Content='{{TemplateBinding Content}}' ContentTemplate='{{TemplateBinding ContentTemplate}}' HorizontalContentAlignment='Stretch'/><VisualStateManager.VisualStateGroups><VisualStateGroup x:Name='CommonStates'><VisualState x:Name='Normal'/><VisualState x:Name='PointerOver'><VisualState.Setters><Setter Target='Fill.Opacity' Value='.6'/></VisualState.Setters></VisualState><VisualState x:Name='Selected'><VisualState.Setters><Setter Target='Fill.Opacity' Value='1'/></VisualState.Setters></VisualState><VisualState x:Name='PointerOverSelected'><VisualState.Setters><Setter Target='Fill.Opacity' Value='1'/></VisualState.Setters></VisualState></VisualStateGroup></VisualStateManager.VisualStateGroups></Grid></ControlTemplate>")));
        return style;
    }
    /// <summary>Kokuban's pane, line and pills. No default button: ContentDialog swaps a default button to the system accent style.</summary>
    private void StyleDialog(ContentDialog dialog, string? primaryInk = null)
    {
        dialog.RequestedTheme = ActualTheme;
        dialog.Foreground = Theme.Brush(this, "Ink");
        dialog.CornerRadius = new CornerRadius(20); dialog.Background = Theme.Brush(this, "PaneBrush");
        dialog.BorderBrush = Theme.Brush(this, "LineBrush"); dialog.BorderThickness = new Thickness(1);
        dialog.Resources["ContentDialogPadding"] = new Thickness(24);
        dialog.DefaultButton = ContentDialogButton.None;
        var pill = (Style)Application.Current.Resources["PillButton"];
        dialog.CloseButtonStyle = pill;
        dialog.PrimaryButtonStyle = primaryInk is null ? pill : new Style(typeof(Button)) { BasedOn = pill, Setters = { new Setter(Control.ForegroundProperty, Theme.Brush(this, primaryInk)) } };
        dialog.Opened += (_, _) => Motion.Enter(dialog, 0, rise: 5, ms: 200);
    }
    private TextBlock Label(string text) => new() { Text = text, Style = (Style)Application.Current.Resources["LabelText"], Margin = new Thickness(2, 0, 0, 6) };
    private void Paint()
    {
        _root.Background = Theme.Brush(this, "PaneBrush");
        _status.Foreground = _problem.Foreground = Theme.Brush(this, "Ink2");
        _composer.Background = Theme.Brush(this, "Fill1");
        _send.Background = Theme.Brush(this, "AccentBlue"); _send.Foreground = Theme.White;
        _shutdown.Foreground = Theme.Brush(this, "Danger");
    }
    public void Dispose() { _refresh.Stop(); _closed.Cancel(); _reading?.Cancel(); _client.Dispose(); }
    public void Detach() { _reading?.Cancel(); }
    public async Task Attach()
    {
        await Refresh();
        if (_selected is { } s && (_reading is null || _reading.IsCancellationRequested))
        {
            _reading?.Dispose(); _reading = CancellationTokenSource.CreateLinkedTokenSource(_closed.Token);
            _ = Read(s, _reading.Token);
        }
    }
    private string Host => _pc.SelectedItem?.ToString() ?? "local";
    private async Task Refresh()
    {
        try
        {
            var hosts = _pc.Items.Cast<string>().ToArray();
            await Task.WhenAll(hosts.Select(async host =>
            {
                try
                {
                    var response = await _client.ConversationAsync(new { op = "list", pc = host }, _closed.Token);
                    foreach (var session in response.Sessions) _known[session.Id] = session;
                    _hostErrors.Remove(host);
                }
                catch (Exception e) when (e is BoardException or HttpRequestException) { _hostErrors[host] = ConversationRules.HostProblem(host, e.Message); }
            }));
            RenderSessions(); ShowProblem();
        }
        catch (OperationCanceledException) { }
    }
    private void RenderSessions()
    {
        if (_selected is { } current) _known[current.Id] = current;
        var rows = _known.Values.OrderByDescending(s => s.Phase is "working" or "approval").ThenBy(s => s.Name).ToList();
        var signature = string.Join('|', rows.Select(s => $"{s.Id}:{s.Name}:{s.Phase}"));
        if (signature == _listSignature) return;
        _listSignature = signature;
        var selected = _selected?.Id;
        _sessions.ItemsSource = rows;
        if (selected is not null) _sessions.SelectedItem = _known.GetValueOrDefault(selected);
    }
    private bool _launchOpen;
    private async Task Launch()
    {
        if (_launchOpen) return;
        _launchOpen = true;
        try
        {
            var host = Host;
            var prior = _outbox.Pending(host).FirstOrDefault(p => p.GetProperty("op").GetString() == "launch");
            if (prior.ValueKind != JsonValueKind.Undefined)
            {
                var check = new ContentDialog { XamlRoot = _root.XamlRoot, Title = "Check the previous launch", Content = "Launch unconfirmed. Check its status before starting another.", PrimaryButtonText = "Check launch", CloseButtonText = "Cancel" };
                StyleDialog(check);
                if (await check.ShowAsync() == ContentDialogResult.Primary) { var response = await Deliver(prior); if (response.Session is { } existing) { _known[existing.Id] = existing; await Select(existing); await Refresh(); } }
                return;
            }
            ConversationResponse catalog;
            try { catalog = await _client.ConversationAsync(new { op = "catalog", pc = host }, _closed.Token); }
            catch (Exception e) when (e is BoardException or HttpRequestException) { _hostErrors[host] = ConversationRules.HostProblem(host, e.Message); ShowProblem(); return; }
            // The person chose another host while the catalog loaded: this dialog would launch on the wrong PC.
            if (host != Host) return;
            await ShowLaunch(host, catalog.Projects);
            await Refresh();
        }
        catch (System.Runtime.InteropServices.COMException) { _commandError = "Close the open dialog before starting another agent."; ShowProblem(); }
        catch (Exception e) when (e is BoardException or HttpRequestException or OperationCanceledException) { _commandError = e.Message; ShowProblem(); }
        finally { _launchOpen = false; }
    }
    /// <summary>The launch sheet: Kokuban's own rows, segments and pills instead of ContentDialog's buttons and combo boxes.</summary>
    private async Task ShowLaunch(string host, IReadOnlyList<ConversationProject> catalog)
    {
        var where = host == "local" ? "this PC" : host;
        var dialog = new ContentDialog { XamlRoot = _root.XamlRoot };
        AutomationProperties.SetName(dialog, "New shared agent");
        StyleDialog(dialog);
        var sheet = new StackPanel { Width = 400 };
        void Group(FrameworkElement element, double below = 16) { element.Margin = new Thickness(element.Margin.Left, element.Margin.Top, element.Margin.Right, below); sheet.Children.Add(element); }
        Group(new TextBlock { Text = "New agent", FontSize = 22, FontFamily = Theme.Display, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold }, 2);
        Group(new TextBlock { Text = "Shared from " + where, FontSize = 12, Foreground = Theme.Brush(this, "Ink2") }, 20);

        // Projects: rounded rows on a filled track, like the sidebar's agents.
        Group(Label("Project"), 0);
        var projects = new ListView { SelectionMode = ListViewSelectionMode.Single, ItemsSource = catalog, MaxHeight = 196, Padding = new Thickness(4), ItemContainerStyle = RowStyle("Fill2") };
        projects.ItemTemplate = (DataTemplate)Microsoft.UI.Xaml.Markup.XamlReader.Load("<DataTemplate xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'><TextBlock Text='{Binding Name}' Padding='12,8' FontSize='14' TextTrimming='CharacterEllipsis'/></DataTemplate>");
        AutomationProperties.SetName(projects, "Project on " + where);
        if (catalog.Count == 1) projects.SelectedIndex = 0;
        FrameworkElement projectBody = catalog.Count > 0 ? projects
            : new TextBlock { Text = $"No projects on {where}. Add a folder to githubprojects there.", TextWrapping = TextWrapping.Wrap, FontSize = 13, Foreground = Theme.Brush(this, "Ink2"), Padding = new Thickness(14, 12, 14, 12) };
        Group(new Border { Background = Theme.Brush(this, "Fill1"), CornerRadius = new CornerRadius(14), Child = projectBody });

        // Agent: a two-segment pill rather than a combo box.
        Group(Label("Agent"), 0);
        var provider = "codex";
        var segments = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2, Padding = new Thickness(3), CornerRadius = new CornerRadius(20), Background = Theme.Brush(this, "Fill1"), HorizontalAlignment = HorizontalAlignment.Left };
        var choices = new[] { ("codex", "Codex"), ("claude", "Claude") }.Select(c =>
        {
            var b = new Button { Content = c.Item2, Tag = c.Item1, Padding = new Thickness(18, 5, 18, 5) };
            StyleButton(b); segments.Children.Add(b); return b;
        }).ToArray();
        void PaintSegments()
        {
            foreach (var b in choices)
            {
                var on = (string)b.Tag == provider;
                b.Background = on ? Theme.Brush(this, "Fill2") : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
                b.Foreground = Theme.Brush(this, on ? "Ink" : "Ink2");
                AutomationProperties.SetName(b, $"{b.Content} agent{(on ? ", selected" : "")}");
            }
        }
        foreach (var b in choices) b.Click += (_, _) => { provider = (string)b.Tag; PaintSegments(); };
        PaintSegments(); Group(segments);

        Group(Label("Name"), 0);
        var name = new TextBox { PlaceholderText = "Automatic", MaxLength = 40 };
        Group(name);
        Group(Label("First message"), 0);
        var prompt = new TextBox { PlaceholderText = "Optional", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 72, MaxHeight = 160, MaxLength = ConversationRules.MessageBytes };
        Group(prompt, 10);
        foreach (var field in new Control[] { name, prompt }) StyleField(field);
        AutomationProperties.SetName(name, "Agent name"); AutomationProperties.SetName(prompt, "First message");
        // Truthful about host policy: Kokuban relays the host's own approval requests and never changes its settings.
        var policy = new TextBlock { Text = "Host permissions apply; tools may run without asking.", TextWrapping = TextWrapping.Wrap, FontSize = 12, Foreground = Theme.Brush(this, "Ink2") };
        ToolTipService.SetToolTip(policy, "Approval prompts appear only when the host's agent settings require them.");
        Group(policy, 8);
        var error = new TextBlock { TextWrapping = TextWrapping.Wrap, FontSize = 12, Foreground = Theme.Brush(this, "Danger"), Visibility = Visibility.Collapsed, IsTextSelectionEnabled = true };
        AutomationProperties.SetLiveSetting(error, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Assertive);
        Group(error, 8);

        var cancel = new Button { Content = "Cancel" };
        var launch = new Button { Content = "Launch", MinWidth = 96 };
        StyleButton(cancel); StyleButton(launch);
        launch.Background = Theme.Brush(this, "AccentBlue"); launch.Foreground = Theme.White;
        var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 12, 0, 0) };
        footer.Children.Add(cancel); footer.Children.Add(launch); sheet.Children.Add(footer);
        dialog.Content = sheet;

        var id = Guid.NewGuid().ToString(); object? pendingLaunch = null; var busy = false;
        void Problem(string? text)
        {
            error.Text = text ?? "";
            var hidden = string.IsNullOrEmpty(text);
            if (!hidden && error.Visibility == Visibility.Collapsed) Motion.Enter(error, 0, rise: 3, ms: 160);
            error.Visibility = hidden ? Visibility.Collapsed : Visibility.Visible;
        }
        string? Invalid() => !ConversationRules.ValidName(name.Text) ? "Names use letters, numbers, underscores or hyphens."
            : !ConversationRules.Fits(prompt.Text) ? ConversationRules.TooLong(prompt.Text) : null;
        void Update()
        {
            // An unconfirmed launch keeps its fields: retrying must send the same request.
            var editable = !busy && pendingLaunch is null;
            projects.IsEnabled = name.IsEnabled = prompt.IsEnabled = editable;
            foreach (var b in choices) b.IsEnabled = editable;
            launch.IsEnabled = !busy && projects.SelectedItem is ConversationProject && Invalid() is null;
            launch.Content = busy ? "Launching…" : pendingLaunch is null ? "Launch" : "Check launch";
        }
        async Task Go()
        {
            if (!launch.IsEnabled || projects.SelectedItem is not ConversationProject project) return;
            pendingLaunch ??= new { op = "launch", pc = host, launch = new { id, projectId = project.Id, provider, name = string.IsNullOrWhiteSpace(name.Text) ? null : name.Text, text = prompt.Text } };
            busy = true; Problem(null); Update();
            try
            {
                var response = await Deliver(pendingLaunch);
                if (response.Session is { } s) { _known[s.Id] = s; busy = false; dialog.Hide(); await Select(s); }
            }
            catch (BoardRefusedException e) when (e.Definitive) { pendingLaunch = null; id = Guid.NewGuid().ToString(); Problem(ConversationRules.HostProblem(where, e.Message)); }
            catch (Exception e) when (e is BoardException or HttpRequestException or OperationCanceledException) { Problem(ConversationRules.HostProblem(where, e.Message) + " Check launch before starting another."); }
            finally { busy = false; Update(); }
        }
        projects.SelectionChanged += (_, _) => Update();
        name.TextChanged += (_, _) => { Problem(ConversationRules.ValidName(name.Text) ? null : Invalid()); Update(); };
        prompt.TextChanged += (_, _) => { Problem(ConversationRules.Fits(prompt.Text) ? null : Invalid()); Update(); };
        name.KeyDown += async (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter) { e.Handled = true; await Go(); } };
        prompt.KeyDown += async (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter && Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(Windows.System.VirtualKey.Control).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down)) { e.Handled = true; await Go(); } };
        launch.Click += async (_, _) => await Go();
        cancel.Click += (_, _) => dialog.Hide();
        // Closing while a launch is in flight would hide its result; the outbox keeps it either way.
        dialog.Closing += (_, args) => { if (busy) args.Cancel = true; };
        dialog.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Escape && !busy) { e.Handled = true; dialog.Hide(); }
        };
        ToolTipService.SetToolTip(launch, "Launch · Enter in Name, Ctrl+Enter in the message");
        Update();
        await dialog.ShowAsync();
    }
    private Task Select(Conversation s)
    {
        if (_selected?.Id == s.Id) { _selected = s; SetControls(); return Task.CompletedTask; }
        _reading?.Cancel(); _reading = CancellationTokenSource.CreateLinkedTokenSource(_closed.Token);
        if (_selected is { } previous && _pendingSend is null) _drafts[previous.Id] = _composer.Text;
        _selected = s; _cursor = 0; _assistant = null; _opened = false; _legacyHistory = false; _view++; _pendingSend = null; _window.Open([], null, false); ShowHistoryControls(); _composer.Text = _drafts.GetValueOrDefault(s.Id, "");
        _commandError = _connectionError = null;
        var pending = _outbox.Pending(s.Host, s.Id).FirstOrDefault(p => p.GetProperty("command").GetProperty("op").GetString() == "message");
        if (pending.ValueKind != JsonValueKind.Undefined) { _pendingSend = pending; _composer.Text = pending.GetProperty("command").GetProperty("text").GetString() ?? ""; _commandError = "Delivery unconfirmed. Retry to check."; }
        ShowProblem();
        SetControls();
        Motion.Enter(_root, 0, rise: 4, ms: 180);
        _ = Read(s, _reading.Token);
        return Task.CompletedTask;
    }
    private async Task Read(Conversation selected, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (!_opened)
                {
                    // The newest bounded page, then live events after its last seq. An older host
                    // without 'history' answers "Unknown conversation operation"; read it from the start.
                    try { await ShowLatest(selected, ct); }
                    catch (BoardRefusedException e) when (e.Status == 400 && e.Message.Contains("Unknown conversation operation")) { _legacyHistory = true; }
                    if (ct.IsCancellationRequested) return;
                    _opened = true;
                }
                var after = _cursor;
                var page = await _client.ConversationAsync(new { op = "events", pc = selected.Host, sessionId = selected.Id, after, waitMs = 4000 }, ct);
                if (ct.IsCancellationRequested) return;
                // Latest moved the cursor back while this poll waited: drop this page and read again from there, leaving no gap.
                if (after == _cursor)
                    foreach (var e in page.Events)
                    {
                        if (e.Seq <= _cursor) continue;
                        _cursor = e.Seq;
                        // While earlier history is shown, live output is kept on the host and appears on Latest.
                        if (_window.Browsing) { _assistant = null; continue; }
                        var added = new List<object>(); Append(e, added, ref _assistant);
                        foreach (var item in added) _window.AddLive(item);
                    }
                ShowHistoryControls();
                var current = await _client.ConversationAsync(new { op = "get", pc = selected.Host, sessionId = selected.Id }, ct);
                if (ct.IsCancellationRequested) return;
                if (current.Session is { } s) { _selected = s; _known[s.Id] = s; SetControls(); }
                _connectionError = null; ShowProblem();
                await Task.Delay(100, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception e) when (e is BoardException or HttpRequestException or OperationCanceledException)
            {
                _connectionError = "Disconnected. The host may still be working. " + e.Message; ShowProblem();
                try { await Task.Delay(2000, ct); } catch (OperationCanceledException) { return; }
            }
        }
    }
    /// <summary>Shows the newest bounded page and follows live output again. Drafts and errors are untouched.</summary>
    private async Task ShowLatest(Conversation selected, CancellationToken ct)
    {
        var view = ++_view;
        var latest = await _client.ConversationAsync(new { op = "history", pc = selected.Host, sessionId = selected.Id }, ct);
        if (view != _view || _selected?.Id != selected.Id || ct.IsCancellationRequested) return;
        var items = new List<object>(); TextBlock? assistant = null;
        foreach (var e in latest.Events) Append(e, items, ref assistant);
        _window.Open(items, latest.Before, latest.HasMore); _assistant = assistant;
        // Live reading continues after this page; anything newer is read again rather than skipped.
        if (latest.Events.Count > 0) _cursor = latest.Events[^1].Seq;
        ShowHistoryControls();
    }
    private async Task ReturnToLatest(Conversation selected)
    {
        try { await ShowLatest(selected, _closed.Token); }
        catch (Exception e) when (e is BoardException or HttpRequestException or OperationCanceledException) { _commandError = e.Message; ShowProblem(); }
    }
    private async Task LoadEarlier()
    {
        if (_loadingEarlier || _selected is not { } selected || _window.Before is not { } before) return;
        var view = _view;
        _loadingEarlier = true; _earlier.IsEnabled = false;
        try
        {
            var page = await _client.ConversationAsync(new { op = "history", pc = selected.Host, sessionId = selected.Id, before }, _closed.Token);
            if (view != _view || _selected?.Id != selected.Id) return;
            var first = (_transcript.ItemsPanelRoot as ItemsStackPanel)?.FirstVisibleIndex ?? -1;
            var anchor = first >= 0 && first < _transcript.Items.Count ? _transcript.Items[first] : null;
            var items = new List<object>(); TextBlock? assistant = null;
            foreach (var e in page.Events) Append(e, items, ref assistant);
            _window.Prepend(items, page.Before ?? before, page.HasMore);
            if (anchor is not null && _transcript.Items.Contains(anchor))
            {
                _transcript.UpdateLayout();
                _transcript.ScrollIntoView(anchor, ScrollIntoViewAlignment.Leading);
            }
            if (_window.Browsing) _assistant = null;
            _commandError = null; ShowProblem();
        }
        catch (Exception e) when (e is BoardException or HttpRequestException or OperationCanceledException) { _commandError = e.Message; ShowProblem(); }
        finally { _loadingEarlier = false; _earlier.IsEnabled = true; ShowHistoryControls(); }
    }
    private void ShowHistoryControls()
    {
        _earlier.Visibility = !_legacyHistory && _window.HasMore ? Visibility.Visible : Visibility.Collapsed;
        _latest.Visibility = _window.Browsing ? Visibility.Visible : Visibility.Collapsed;
    }
    /// <summary>Renders one event at the end of <paramref name="items"/>. Each new entry is tagged with the seq that began it.</summary>
    private void Append(ConversationEvent e, IList<object> items, ref TextBlock? assistant)
    {
        void Add(FrameworkElement item) { item.Tag = e.Seq; items.Add(item); }
        if (e.Kind == "assistant_delta")
        {
            if (assistant is null || assistant.Text.Length + (e.Text?.Length ?? 0) > 32000) { assistant = Text(""); Add(assistant); }
            assistant.Text += e.Text;
        }
        else
        {
            if (e.Kind == "launched" && e.Data is { } data && data.TryGetProperty("firstMessage", out var first) && first.ValueKind == JsonValueKind.Object)
                Add(Text($"{e.Actor?.Person}\n{first.GetProperty("text").GetString()}"));
            if (e.Kind == "message") { assistant = null; Add(Text($"{e.Actor?.Person ?? "Participant"}\n{e.Text}")); }
            else if (e.Kind is "tool" or "tool_result")
            {
                assistant = null;
                var content = new StackPanel { Spacing = 8 }; content.Children.Add(Text(e.Data?.ToString() ?? ""));
                if (e.Data is { } details && details.TryGetProperty("detailId", out var detailId) && _selected is { } selected)
                {
                    var load = new Button { Content = "Load full details" };
                    load.Click += async (_, _) =>
                    {
                        try { var response = await _client.ConversationAsync(new { op = "detail", pc = selected.Host, sessionId = selected.Id, eventId = detailId.GetString() }, _closed.Token); content.Children.Clear(); content.Children.Add(Text(response.Events.FirstOrDefault()?.Data?.ToString() ?? "No details available.")); }
                        catch (Exception error) when (error is BoardException or HttpRequestException or OperationCanceledException) { _commandError = error.Message; ShowProblem(); }
                    };
                    content.Children.Add(load);
                }
                Add(Disclosure((e.Text ?? e.Kind)[..Math.Min((e.Text ?? e.Kind).Length, 160)], content));
            }
            else if (e.Kind is "stopped" or "shutdown" or "error" or "recovery") { assistant = null; Add(Text(e.Text ?? e.Kind)); }
        }
    }
    private static FrameworkElement Disclosure(string label, FrameworkElement content)
    {
        var panel = new StackPanel { Spacing = 6 };
        var button = new Button { Content = "›  " + label, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left };
        button.Style = (Style)Application.Current.Resources["RowButton"]; Motion.Pressable(button);
        content.Visibility = Visibility.Collapsed;
        AutomationProperties.SetName(button, label + ", collapsed");
        button.Click += (_, _) => { var open = content.Visibility == Visibility.Collapsed; content.Visibility = open ? Visibility.Visible : Visibility.Collapsed; button.Content = (open ? "⌄  " : "›  ") + label; AutomationProperties.SetName(button, label + (open ? ", expanded" : ", collapsed")); if (open) Motion.Enter(content, 0, rise: 3, ms: 160); };
        panel.Children.Add(button); panel.Children.Add(content); return panel;
    }
    private static TextBlock Text(string text) => new() { Text = text, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, Margin = new Thickness(4, 8, 12, 8), MaxWidth = 740, HorizontalAlignment = HorizontalAlignment.Left };
    private void SetControls()
    {
        RenderSessions();
        var s = _selected; _title.Text = s?.Name ?? "Shared agents";
        var status = s is null ? "Choose an agent, or start a new one." : $"{s.Provider} · {s.Project} · {s.Host} · {s.Phase}";
        if (_status.Text != status)
        {
            _status.Text = status;
            Microsoft.UI.Xaml.Automation.Peers.FrameworkElementAutomationPeer.FromElement(_status)?.RaiseAutomationEvent(Microsoft.UI.Xaml.Automation.Peers.AutomationEvents.LiveRegionChanged);
        }
        _send.IsEnabled = !_sending && s is not null && s.Phase is not ("closed" or "closing" or "error" or "recovery") && ConversationRules.Fits(_composer.Text);
        _stop.IsEnabled = s is not null && s.Phase is "working" or "approval" or "idle";
        _resume.IsEnabled = s?.Phase == "stopped"; _restart.IsEnabled = s?.Phase is "closed" or "error" or "recovery";
        _shutdown.IsEnabled = s is not null && s.Phase is not ("closed" or "closing");
        _retry.IsEnabled = s is not null && _outbox.Pending(s.Host, s.Id).Count > 0;
        _send.Content = s?.Phase is "stopped" or "stopping" ? "Queue" : s?.Phase is "working" or "approval" ? "Queue" : "Send";
        var signature = s is null ? "" : $"{s.Id}:{s.Phase}:{string.Join(',', s.Messages.Where(m => m.State == "queued").Select(m => m.Id))}:{string.Join(',', s.Approvals.Select(a => a.Id))}";
        foreach (var button in new[] { _resume, _restart, _retry }) button.Visibility = button.IsEnabled ? Visibility.Visible : Visibility.Collapsed;
        _composer.IsEnabled = !_sending && s is not null && s.Phase is not ("closed" or "closing" or "error" or "recovery") && _pendingSend is null;
        _sessions.IsEnabled = !_sending;
        if (signature == _controlSignature) return; _controlSignature = signature;
        _queue.Children.Clear();
        var queued = s?.Messages.Where(m => m.State == "queued").ToArray() ?? [];
        if (queued.Length > 0) _queue.Children.Add(Disclosure($"{queued.Length} queued" + (s?.Phase is "stopped" or "stopping" ? " · held" : ""), Text(string.Join("\n\n", queued.Select(m => $"{m.Actor.Person}: {m.Text}")))));
        _approvals.Children.Clear();
        foreach (var a in s?.Approvals.Where(a => a.State == "pending") ?? [])
        {
            var panel = new StackPanel { Spacing = 6 }; panel.Children.Add(Text(a.Description));
            panel.Children.Add(Disclosure("Details", Text(a.Options?.ToString() ?? "")));
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            var allow = new Button { Content = "Allow once" }; var deny = new Button { Content = "Deny" }; StyleButton(allow); StyleButton(deny);
            var subject = $"{a.Kind}: {(a.Description.Length > 120 ? a.Description[..120] + "…" : a.Description)}";
            AutomationProperties.SetName(allow, "Allow once, " + subject); AutomationProperties.SetName(deny, "Deny, " + subject);
            allow.Click += async (_, _) => await Command("approve", a.Id, true); deny.Click += async (_, _) => await Command("approve", a.Id, false);
            row.Children.Add(allow); row.Children.Add(deny); panel.Children.Add(row); _approvals.Children.Add(panel);
        }
    }
    private async Task Send()
    {
        if (_sending || _selected is not { } s || string.IsNullOrWhiteSpace(_composer.Text)) return;
        if (!ConversationRules.Fits(_composer.Text)) { ShowLimit(); return; }
        _sending = true; _send.IsEnabled = false; _composer.IsEnabled = false;
        try
        {
            _pendingSend ??= new { op = "command", pc = s.Host, command = new { id = Guid.NewGuid().ToString(), sessionId = s.Id, epoch = s.Epoch, controlRevision = s.ControlRevision, op = "message", text = _composer.Text } };
            await Deliver(_pendingSend); _pendingSend = null; _composer.Text = ""; _drafts.Remove(s.Id); _commandError = null;
            // A new message returns to the live conversation.
            if (_window.Browsing && _selected?.Id == s.Id) await ReturnToLatest(s);
        }
        catch (BoardRefusedException e) when (e.Definitive) { _pendingSend = null; _commandError = e.Message; }
        catch (Exception e) when (e is BoardException or HttpRequestException or OperationCanceledException) { _commandError = e.Message + " Retry to check delivery."; }
        finally { _sending = false; _composer.IsEnabled = true; ShowProblem(); SetControls(); }
    }
    private async Task Command(string operation, string? approvalId = null, bool? allow = null)
    {
        if (_selected is not { } s) return;
        try
        {
            var result = await Deliver(new { op = "command", pc = s.Host, command = new { id = Guid.NewGuid().ToString(), sessionId = s.Id, epoch = s.Epoch, controlRevision = s.ControlRevision, turnId = s.TurnId, op = operation, approvalId, allow } });
            if (result.Session is { } current) _selected = current; _commandError = null; ShowProblem(); SetControls();
        }
        catch (Exception e) when (e is BoardException or HttpRequestException or OperationCanceledException) { _commandError = e.Message; ShowProblem(); }
    }
    private void ShowProblem() =>
        _problem.Text = string.Join("\n", new[] { _commandError, _connectionError, _selected?.Problem, _hostErrors.GetValueOrDefault(Host) }.Where(t => !string.IsNullOrEmpty(t)).Distinct());
    private void ShowLimit()
    {
        var fits = ConversationRules.Fits(_composer.Text);
        _limit.Text = fits ? "" : ConversationRules.TooLong(_composer.Text);
        _limit.Visibility = fits ? Visibility.Collapsed : Visibility.Visible;
        SetControls();
    }

    private async Task<ConversationResponse> Deliver(object request)
    {
        var immutable = request is JsonElement element ? element : JsonSerializer.SerializeToElement(request, ConversationRules.Json);
        _outbox.Save(immutable);
        try
        {
            var response = await _client.ConversationAsync(immutable, _closed.Token);
            _outbox.Confirm(immutable);
            return response;
        }
        catch (BoardRefusedException e) when (e.Definitive) { _outbox.Confirm(immutable); throw; }
    }
}
