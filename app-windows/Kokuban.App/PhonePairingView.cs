using Kokuban.App.Ui;
using Kokuban.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using System.Text.Json;
using Windows.Storage.Streams;

namespace Kokuban.App;

/// <summary>Dove's 05 pairing sheet, backed by owner-authorized QR claims and actual phone milestones.</summary>
public sealed class PhonePairingView : IDisposable
{
    private readonly PhoneClient _client = new();
    private CancellationTokenSource? _closed;
    private ContentDialog? _dialog;
    private StackPanel? _body;
    private string? _id;
    private string _stage = "";
    private bool _paired;
    private bool _creating;
    private TextBlock? _countdown;
    private long _expires;
    private DispatcherTimer? _clock;
    private readonly FrameworkElement _owner;
    public PhonePairingView(FrameworkElement owner) => _owner = owner;
    private TextBlock Text(string text, double size = 14, string brush = "Ink2") => new() { Text = text, FontSize = size, Foreground = Theme.Brush(_owner, brush), TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, HorizontalAlignment = HorizontalAlignment.Stretch };
    private Button Button(string label, Action action, bool primary = false)
    {
        var b = new Button { Content = label, Style = (Style)Application.Current.Resources["PillButton"], HorizontalAlignment = HorizontalAlignment.Stretch, MinHeight = 44 };
        if (primary) { b.Background = Theme.Brush(_owner, "AccentBlue"); b.Foreground = Theme.White; }
        b.Click += (_, _) => action(); Motion.Pressable(b); return b;
    }
    private void Heading(string title, string detail)
    {
        _body!.Children.Add(Text(title, 28, "Ink")); _body.Children.Add(Text(detail));
    }
    public async Task Show()
    {
        if (_dialog is not null) return;
        _closed = new(); _body = new StackPanel { Width = 360, Spacing = 16, Padding = new Thickness(6, 8, 6, 4) };
        var scroller = new ScrollViewer { Content = _body, MaxHeight = Math.Max(240, _owner.ActualHeight - 170), VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        _dialog = new ContentDialog { XamlRoot = _owner.XamlRoot, Content = scroller, CloseButtonText = "Close", RequestedTheme = _owner.ActualTheme };
        _dialog.Background = Theme.Brush(_owner, "PaneBrush"); _dialog.Foreground = Theme.Brush(_owner, "Ink");
        _dialog.Resources["ContentDialogPadding"] = new Thickness(24);
        _dialog.CloseButtonStyle = (Style)Application.Current.Resources["PillButton"];
        AutomationProperties.SetName(_dialog, "Pair iPhone with Kokuban");
        _dialog.Opened += (_, _) => Motion.Enter(_body, 0, rise: 5, ms: 180);
        _clock = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) }; _clock.Tick += (_, _) => UpdateCountdown(); _clock.Start();
        Heading("iPhones", "Loading your paired devices…");
        _ = LoadDevices(); _ = Watch(_closed.Token);
        try { await _dialog.ShowAsync(); }
        finally
        {
            _closed.Cancel(); _clock.Stop();
            if (_id is not null && !_paired) { try { await _client.Call(new { op = "pair-cancel", id = _id }); } catch { } }
            _dialog = null; _id = null; _stage = "";
        }
    }
    private async Task LoadDevices()
    {
        try
        {
            if (_id is not null && !_paired) await _client.Call(new { op = "pair-cancel", id = _id }, _closed!.Token);
            await _client.Call(new { op = "enable" }, _closed!.Token);
            var data = await _client.Call(new { op = "list" }, _closed.Token);
            if (_closed.IsCancellationRequested) return;
            _id = null; _stage = "devices"; _paired = false; _body!.Children.Clear(); _countdown = null;
            Heading("Your iPhones", "Kokuban stays on this PC. Your paired phones connect over Tailscale.");
            var rows = new StackPanel { Spacing = 10 };
            foreach (var d in data.GetProperty("devices").EnumerateArray())
            {
                if (d.TryGetProperty("revoked", out var revoked) && revoked.ValueKind == JsonValueKind.Number) continue;
                var id = d.GetProperty("id").GetString()!; var name = d.GetProperty("name").GetString()!;
                var row = new StackPanel { Spacing = 4 }; row.Children.Add(Text(name, 16, "Ink")); row.Children.Add(Text(d.GetProperty("node").GetString() ?? "", 12));
                row.Children.Add(Button("Remove", () => ConfirmRemove(id, name))); rows.Children.Add(row);
            }
            if (rows.Children.Count == 0) rows.Children.Add(Text("No phones paired yet."));
            _body.Children.Add(new ScrollViewer { Content = rows, MaxHeight = 260, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
            _body.Children.Add(Button("Pair iPhone", () => _ = NewPair(), true));
            _body.Children.Add(Text("Pair iPhone authorizes the phone that scans your QR and uses your Tailscale account.", 12));
        }
        catch (Exception e) { Problem(e); }
    }
    private void ConfirmRemove(string id, string name)
    {
        _body!.Children.Clear(); Heading($"Remove {name}?", "This phone loses access immediately. Conversation history stays saved.");
        _body.Children.Add(Button("Remove phone", async () => { try { await _client.Call(new { op = "revoke", id }, _closed!.Token); await LoadDevices(); } catch (Exception e) { Problem(e); } }, true));
        _body.Children.Add(Button("Keep phone", () => _ = LoadDevices()));
    }
    private async Task NewPair()
    {
        if (_creating) return;
        _creating = true;
        try
        {
            if (_id is not null && !_paired) await _client.Call(new { op = "pair-cancel", id = _id }, _closed!.Token);
            _id = Guid.NewGuid().ToString(); _paired = false; _stage = "creating"; _countdown = null; _body!.Children.Clear(); Heading("Pair your iPhone", "Creating a private, single-use pairing QR…");
            var v = await _client.Call(new { op = "pair-create", id = _id }, _closed!.Token);
            if (_closed.IsCancellationRequested) return;
            var data = v.GetProperty("qr").GetString()!; var bytes = Convert.FromBase64String(data[(data.IndexOf(',') + 1)..]);
            using var stream = new InMemoryRandomAccessStream(); using (var writer = new DataWriter(stream)) { writer.WriteBytes(bytes); await writer.StoreAsync(); writer.DetachStream(); }
            stream.Seek(0); var bitmap = new BitmapImage(); await bitmap.SetSourceAsync(stream);
            if (_closed.IsCancellationRequested) return;
            _body.Children.Clear(); var image = new Image { Source = bitmap, Width = 224, Height = 224, Stretch = Stretch.Uniform };
            AutomationProperties.SetName(image, "Single-use iPhone pairing QR. Expires in five minutes.");
            _body.Children.Add(new Border { Child = image, Background = new SolidColorBrush(Microsoft.UI.Colors.White), CornerRadius = new CornerRadius(18), Padding = new Thickness(12), HorizontalAlignment = HorizontalAlignment.Center });
            Heading("Pair your iPhone", "Open Camera on your iPhone and scan this QR. Tailscale must be connected to your account.");
            _expires = v.GetProperty("setup").GetProperty("expires").GetInt64(); _countdown = Text(""); _body.Children.Add(_countdown); _stage = "offered"; UpdateCountdown();
            _body.Children.Add(Button("Show a new QR", () => _ = NewPair()));
        }
        catch (Exception e) { Problem(e); }
        finally { _creating = false; }
    }
    private void UpdateCountdown()
    {
        if (_countdown is null || _stage != "offered") return;
        var seconds = Math.Max(0, (_expires - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) / 1000);
        _countdown.Text = seconds == 0 ? "This QR expired. Show a new one." : $"Expires in {seconds / 60}:{seconds % 60:00}";
    }
    private async Task Watch(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await foreach (var _ in _client.Events(ct)) await ReadState(ct); }
            catch when (ct.IsCancellationRequested) { return; }
            catch { try { await Task.Delay(1500, ct); await ReadState(ct); } catch when (ct.IsCancellationRequested) { return; } catch { } }
        }
    }
    private async Task ReadState(CancellationToken ct)
    {
        if (_id is null || _stage == "creating") return;
        var data = await _client.Call(new { op = "pair-state" }, ct); if (ct.IsCancellationRequested) return;
        foreach (var s in data.GetProperty("setups").EnumerateArray()) if (s.GetProperty("id").GetString() == _id)
        {
            var stage = s.GetProperty("stage").GetString() ?? ""; if (stage == _stage) return; _stage = stage;
            if (stage == "offered") return;
            _paired = s.TryGetProperty("deviceId", out var device) && device.ValueKind == JsonValueKind.String;
            _body!.Children.Clear(); _countdown = null;
            var icon = new FontIcon { Glyph = stage == "done" ? "\uE73E" : "\uE8EA", FontFamily = new FontFamily("Segoe Fluent Icons"), FontSize = 54, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 26, 0, 24), Foreground = Theme.Brush(_owner, stage == "done" ? "AccentBlue" : "Ink2") };
            _body.Children.Add(icon);
            var name = s.TryGetProperty("name", out var n) ? n.GetString() ?? "Your iPhone" : "Your iPhone";
            if (stage == "claimed") { Heading("iPhone found", name); _body.Children.Add(Text("Finish adding Kokuban to the Home Screen on your iPhone.")); }
            else if (stage == "appOpened") { Heading("One last step", "Kokuban is open on your iPhone. Choose whether to enable notifications there."); }
            else if (stage == "done") { Heading("You’re connected", name); _body.Children.Add(Button("Done", () => _dialog?.Hide(), true)); }
            else { Heading(stage == "expired" ? "Pairing expired" : "Pairing cancelled", "Show a new QR when your phone is ready."); _body.Children.Add(Button("Show a new QR", () => _ = NewPair(), true)); }
            if (Motion.Enabled) Motion.Enter(_body, 0, rise: 4, ms: 180); return;
        }
    }
    private void Problem(Exception e)
    {
        if (_closed?.IsCancellationRequested != false || _body is null) return;
        _body.Children.Clear(); _countdown = null; Heading("Could not connect", e is BoardException ? e.Message : "Check that Kokuban and Tailscale are running, then try again.");
        _body.Children.Add(Button("Try again", () => _ = LoadDevices(), true));
    }
    public void Dispose() { _closed?.Cancel(); _clock?.Stop(); _dialog?.Hide(); _client.Dispose(); }
}
