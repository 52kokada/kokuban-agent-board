using Kokuban.Core;
using Microsoft.UI.Dispatching;

namespace Kokuban.App;

/// <summary>The board as the app's windows see it: the latest view and the connection, told on the UI thread.</summary>
public sealed class Board : IAsyncDisposable
{
    private readonly BoardClient _client = new();
    private readonly BoardWatcher _watcher;
    private readonly DispatcherQueue _ui;

    public Board(DispatcherQueue ui)
    {
        _ui = ui;
        _watcher = new BoardWatcher(_client);
        _watcher.ViewChanged += _ => _ui.TryEnqueue(() => Changed?.Invoke());
        _watcher.ConnectionChanged += _ => _ui.TryEnqueue(() => Changed?.Invoke());
        _watcher.Start();
    }

    public FeedView? View => _watcher.View;

    public bool Connected => _watcher.Connected || _watcher.View is null && _watcher.Problem is null;

    /// <summary>Raised on the UI thread when the view or the connection changed.</summary>
    public event Action? Changed;

    private static readonly HashSet<string> Opens =
    [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".pdf", ".txt", ".md", ".csv", ".json", ".log",
        ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt", ".mp4", ".mov", ".mp3", ".wav",
    ];

    /// <summary>Tell the board the app is running; quiet when it cannot be told.</summary>
    public async Task Hello()
    {
        try
        {
            await _client.HelloAsync(Environment.ProcessId, Environment.ProcessPath ?? "");
        }
        catch (BoardException)
        {
        }
    }

    /// <summary>
    /// Open one of a card's attachments with the program Windows uses for it. Null when it opened;
    /// otherwise the words to show (the file is on another PC's board).
    /// </summary>
    public async Task<string?> OpenFile(Item item, int n, Strings t)
    {
        try
        {
            var bytes = await _client.FileAsync(item.Thread, n);
            if (bytes is null) return item.Board == View?.Pc ? t.FileGone : string.Format(t.FileElsewhere, item.Board);
            var dir = Path.Combine(Path.GetTempPath(), "kokuban-files", item.Thread.Replace(':', '-'));
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, Path.GetFileName(item.Files[n]));
            await File.WriteAllBytesAsync(file, bytes);
            // Marked as from the internet (zone 3): Office opens it in Protected View and SmartScreen
            // checks it, as for any download. An agent on another PC attached it.
            await File.WriteAllTextAsync(file + ":Zone.Identifier", "[ZoneTransfer]\r\nZoneId=3\r\n");
            // A picture or a document opens; anything else (a program, a script) is only shown in its folder,
            // never run: an agent attached it, and a click must not start it.
            if (Opens.Contains(Path.GetExtension(file).ToLowerInvariant()))
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(file) { UseShellExecute = true });
            else
                System.Diagnostics.Process.Start("explorer.exe", $"/select,\"{file}\"");
            return null;
        }
        catch (Exception e) when (e is BoardException or IOException or System.ComponentModel.Win32Exception)
        {
            return e.Message;
        }
    }

    public async Task<ActResult> Act(string thread, string action, string text)
    {
        try
        {
            var done = await _client.ActAsync(thread, action, text);
            await _watcher.RefreshAsync();
            return done;
        }
        catch (BoardException e)
        {
            return new ActResult(false, null, e.Message);
        }
    }

    public ValueTask DisposeAsync() => _watcher.DisposeAsync();
}
