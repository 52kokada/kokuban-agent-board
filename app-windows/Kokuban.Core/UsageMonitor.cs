using System.Diagnostics;
using System.Text;

namespace Kokuban.Core;

/// <summary>Runs each read-only collector serially on background tasks; never blocks the UI thread.</summary>
public sealed class UsageMonitor : IAsyncDisposable
{
    private readonly string _toolsDirectory;
    private readonly string _nodeExecutable;
    private readonly Uri? _playbackUri;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly HttpClient _http = new(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
    private Task[]? _loops;
    private Task? _disposeTask;
    private bool _disposed;
    private string? _usage, _live, _playback;
    private UsageSnapshot _snapshot = UsageDashboard.Build(null, null, null, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    public event Action? Changed;
    public UsageSnapshot Snapshot { get { lock (_gate) return _snapshot; } }

    public UsageMonitor(string toolsDirectory, string nodeExecutable = "node", Uri? playbackUri = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(toolsDirectory);
        ArgumentException.ThrowIfNullOrWhiteSpace(nodeExecutable);
        _toolsDirectory = Path.GetFullPath(toolsDirectory);
        _nodeExecutable = nodeExecutable;
        if (playbackUri is not null && new LocalUiOptions { PlaybackStatusUrl = playbackUri.AbsoluteUri }.PlaybackUri() is null)
            throw new ArgumentException("Playback must be an explicit HTTP loopback IP endpoint.", nameof(playbackUri));
        _playbackUri = playbackUri;
    }

    public void Start()
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_loops is not null) return;
            _loops = [Task.Run(() => PollScriptAsync("today-usage.mjs", TimeSpan.FromSeconds(30), true)),
                Task.Run(() => PollScriptAsync("live-sessions.mjs", TimeSpan.FromSeconds(5), false)),
                Task.Run(PollPlaybackAsync)];
        }
    }

    private async Task PollScriptAsync(string script, TimeSpan interval, bool usage)
    {
        var cancellation = _stop.Token;
        while (!cancellation.IsCancellationRequested)
        {
            string? result = null;
            try { result = await RunScriptAsync(script, cancellation).ConfigureAwait(false); }
            catch (Exception ex) when (ex is IOException or InvalidOperationException or System.ComponentModel.Win32Exception or OperationCanceledException) { }
            lock (_gate)
            {
                if (_disposed) return;
                if (result is not null) { if (usage) _usage = result; else _live = result; }
            }
            Publish();
            try { await Task.Delay(interval, cancellation).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task<string> RunScriptAsync(string script, CancellationToken cancellation)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = _nodeExecutable, WorkingDirectory = _toolsDirectory, UseShellExecute = false,
                CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            }
        };
        process.StartInfo.ArgumentList.Add(Path.Combine(_toolsDirectory, script));
        process.Start();
        var output = ReadBoundedAsync(process.StandardOutput, 4 * 1024 * 1024, timeout.Token);
        var error = ReadBoundedAsync(process.StandardError, 64 * 1024, timeout.Token);
        // Abort promptly if a pipe exceeds its bound, even while the child keeps writing.
        var reads = Task.WhenAll(output, error);
        foreach (var read in new[] { output, error })
            _ = read.ContinueWith(_ => { try { timeout.Cancel(); } catch (ObjectDisposedException) { } }, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        try
        {
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            await reads.ConfigureAwait(false);
            if (process.ExitCode != 0) throw new IOException("Usage collector failed.");
            return await output.ConfigureAwait(false);
        }
        finally
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            using var exitTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            try { await process.WaitForExitAsync(exitTimeout.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { }
            timeout.Cancel();
            try { await reads.ConfigureAwait(false); } catch (Exception ex) when (ex is IOException or OperationCanceledException) { }
        }
    }

    private static async Task<string> ReadBoundedAsync(StreamReader reader, int limit, CancellationToken cancellation)
    {
        var result = new StringBuilder(); var buffer = new char[4096];
        while (true)
        {
            var count = await reader.ReadAsync(buffer.AsMemory(), cancellation).ConfigureAwait(false);
            if (count == 0) return result.ToString();
            if (result.Length > limit - count) throw new IOException("Usage response exceeds its output limit.");
            result.Append(buffer, 0, count);
        }
    }

    private async Task PollPlaybackAsync()
    {
        if (_playbackUri is null) return;
        var cancellation = _stop.Token;
        while (!cancellation.IsCancellationRequested)
        {
            string? result = null;
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
                timeout.CancelAfter(TimeSpan.FromSeconds(4));
                using var response = await _http.GetAsync(_playbackUri, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
                response.EnsureSuccessStatusCode();
                using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false), Encoding.UTF8);
                result = await ReadBoundedAsync(reader, 64 * 1024, timeout.Token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException) { }
            lock (_gate) { if (_disposed) return; if (result is not null) _playback = result; }
            Publish();
            try { await Task.Delay(TimeSpan.FromSeconds(5), cancellation).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }

    private void Publish()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _snapshot = UsageDashboard.Build(_usage, _live, _playback, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }
        var handlers = Changed;
        if (handlers is null) return;
        foreach (Action handler in handlers.GetInvocationList())
        {
            try { handler(); } catch (Exception) { }
        }
    }

    public ValueTask DisposeAsync()
    {
        lock (_gate)
        {
            if (_disposeTask is not null) return new ValueTask(_disposeTask);
            _disposed = true;
            _stop.Cancel();
            _disposeTask = DisposeCoreAsync(_loops ?? []);
            return new ValueTask(_disposeTask);
        }
    }

    private async Task DisposeCoreAsync(Task[] loops)
    {
        try { await Task.WhenAll(loops).ConfigureAwait(false); }
        finally { _http.Dispose(); _stop.Dispose(); }
    }
}
