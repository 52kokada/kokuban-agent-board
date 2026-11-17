namespace Kokuban.Core;

/// <summary>
/// Keeps the latest view: fetches it when the board's stream says "changed", and reconnects by
/// itself when the board goes away or restarts with a new key. Raises <see cref="ViewChanged"/>
/// only when the view really differs from the last one.
/// </summary>
public sealed class BoardWatcher : IAsyncDisposable
{
    private readonly BoardClient _client;
    private readonly TimeSpan[] _backoff;
    private readonly CancellationTokenSource _stop = new();
    private Task? _loop;
    private string _signature = "";

    public BoardWatcher(BoardClient client, TimeSpan[]? backoff = null)
    {
        _client = client;
        _backoff = backoff ?? [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10)];
    }

    public FeedView? View { get; private set; }

    /// <summary>Whether the board answered on the last try.</summary>
    public bool Connected { get; private set; }

    public string? Problem { get; private set; }

    public event Action<FeedView>? ViewChanged;

    public event Action<bool>? ConnectionChanged;

    public void Start() => _loop ??= Task.Run(() => Run(_stop.Token));

    /// <summary>Fetch now, e.g. right after acting, without waiting for the stream.</summary>
    public async Task RefreshAsync(CancellationToken ct = default)
    {
        Publish(await _client.ViewAsync(ct));
    }

    private async Task Run(CancellationToken ct)
    {
        var failures = 0;
        var expired = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                Publish(await _client.ViewAsync(ct));
                SetConnected(true, null);
                failures = 0;
                expired = 0;
                await foreach (var e in _client.EventsAsync(ct))
                {
                    if (e == "changed") Publish(await _client.ViewAsync(ct));
                }
                // The board closed the stream: it is restarting.
                _client.ForgetKey();
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (KeyExpiredException)
            {
                // Once is a restart; again and again is something else on the port: back off like any failure.
                _client.ForgetKey();
                if (expired++ == 0) continue;
            }
            catch (Exception e) when (e is BoardException or HttpRequestException or IOException)
            {
                SetConnected(false, e is BoardException ? e.Message : "The board is not answering.");
                _client.ForgetKey();
            }
            try
            {
                await Task.Delay(_backoff[Math.Min(failures++, _backoff.Length - 1)], ct);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private void Publish(FeedView view)
    {
        var sig = FeedView.Signature(view);
        lock (_stop)
        {
            if (sig == _signature) return;
            _signature = sig;
            View = view;
        }
        ViewChanged?.Invoke(view);
    }

    private void SetConnected(bool ok, string? problem)
    {
        Problem = problem;
        if (Connected == ok) return;
        Connected = ok;
        ConnectionChanged?.Invoke(ok);
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        if (_loop is not null)
        {
            try { await _loop; } catch (OperationCanceledException) { }
        }
        _stop.Dispose();
    }
}
