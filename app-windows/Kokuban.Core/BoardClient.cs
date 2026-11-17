using System.Net;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Web;

namespace Kokuban.Core;

/// <summary>
/// The board's local routes (src/app-routes.ts), as a program that is not a page uses them:
///
///   GET  /app/key                the per-boot key (an older board: read it from /app/open's address)
///   GET  /app/feed.json?t=       the whole view
///   GET  /app/events?t=          a stream that says "changed"
///   POST /app/act                t, thread, action, text
///
/// The key changes when the board restarts and the old one answers 404, so each call that gets a 404
/// fetches the key again and tries once more.
/// </summary>
public sealed class BoardClient : IDisposable
{
    /// <summary>The board's port on this PC: 47600, or a test board's (KOKUBAN_PORT, or the app's --port).</summary>
    public static int Port { get; set; } = int.TryParse(Environment.GetEnvironmentVariable("KOKUBAN_PORT"), out var p) ? p : 47600;

    /// <summary>A test board, not the real one: what is on it is made up, and the app says so.</summary>
    public static bool Demo => Port != 47600;

    public static Uri DefaultBase => new($"http://127.0.0.1:{Port}/");
    private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(10);

    private readonly HttpClient _http;
    private string? _key;

    public BoardClient(Uri? baseUri = null, HttpMessageHandler? handler = null)
    {
        BaseUri = baseUri ?? DefaultBase;
        // The event stream stays open for hours; every other call has its own timeout.
        _http = new HttpClient(handler ?? new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
        {
            BaseAddress = BaseUri,
            Timeout = Timeout.InfiniteTimeSpan,
        };
    }

    public Uri BaseUri { get; }

    /// <summary>The key in use, if one was fetched.</summary>
    public string? Key => _key;

    public void ForgetKey() => _key = null;

    public async Task<string> KeyAsync(CancellationToken ct = default)
    {
        if (_key is not null) return _key;
        using var res = await Send(() => new HttpRequestMessage(HttpMethod.Get, "app/key"), ct);
        if (res.StatusCode == HttpStatusCode.OK)
        {
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            return _key = doc.RootElement.GetProperty("key").GetString() ?? throw new BoardException("The board sent no key.");
        }
        if (res.StatusCode != HttpStatusCode.NotFound) throw new BoardException($"The board answered {(int)res.StatusCode} for its key.");
        // A board from before /app/key: the key is in the window's address.
        using var open = await Send(() => new HttpRequestMessage(HttpMethod.Get, "app/open?as=window"), ct);
        if (!open.IsSuccessStatusCode) throw new BoardException($"The board answered {(int)open.StatusCode} for its key.");
        using var page = JsonDocument.Parse(await open.Content.ReadAsStringAsync(ct));
        var url = new Uri(page.RootElement.GetProperty("url").GetString() ?? "");
        return _key = HttpUtility.ParseQueryString(url.Query)["t"] ?? throw new BoardException("The board's address has no key.");
    }

    public async Task<FeedView> ViewAsync(CancellationToken ct = default)
    {
        var text = await WithKey(key => new HttpRequestMessage(HttpMethod.Get, $"app/feed.json?t={key}"), ct);
        return FeedView.Parse(text);
    }

    public async Task<ConversationResponse> ConversationAsync(object request, CancellationToken ct = default)
    {
        var text = await WithKey(key => new HttpRequestMessage(HttpMethod.Post, "app/conversations")
        {
            Content = new FormUrlEncodedContent([new("t", key), new("request", ConversationRules.Serialize(request))]),
        }, ct);
        return JsonSerializer.Deserialize<ConversationResponse>(text, FeedView.Json) ?? throw new BoardException("The board sent no conversation response.");
    }

    public async Task<SessionCatalog> SessionsAsync(CancellationToken ct = default)
    {
        var text = await WithKey(key => new HttpRequestMessage(HttpMethod.Get, $"app/sessions?t={key}"), ct);
        try
        {
            var catalog = JsonSerializer.Deserialize<SessionCatalog>(text, FeedView.Json);
            if (catalog?.Sessions is null || catalog.Sessions.Count > 5000 || catalog.Sessions.Any(s => s is null ||
                s.Id is null || s.Name is null || s.Host is null || s.Cwd is null || s.Reason is null)) throw new JsonException();
            return catalog;
        }
        catch (JsonException e) { throw new BoardException("セッション履歴の応答が正しくありません。", e); }
    }

    public async Task<ActResult> LaunchSessionAsync(string target, string id = "", string host = "", string cwd = "", CancellationToken ct = default)
    {
        var text = await WithKey(key => new HttpRequestMessage(HttpMethod.Post, "app/session-launch")
        {
            Content = new FormUrlEncodedContent([new("t", key), new("target", target), new("id", id), new("host", host), new("cwd", cwd)]),
        }, ct);
        try
        {
            var result = JsonSerializer.Deserialize<ActResult>(text, FeedView.Json);
            if (result is null || (result.Ok ? string.IsNullOrWhiteSpace(result.Done) : string.IsNullOrWhiteSpace(result.Error))) throw new JsonException();
            return result;
        }
        catch (JsonException e) { throw new BoardException("起動要求の応答が正しくありません。", e); }
    }

    public async Task<ActResult> ResetSessionLaunchAsync(string id, CancellationToken ct = default)
    {
        var text = await WithKey(key => new HttpRequestMessage(HttpMethod.Post, "app/session-launch/reset")
        {
            Content = new FormUrlEncodedContent([new("t", key), new("id", id), new("confirm", "checked")]),
        }, ct);
        try
        {
            var result = JsonSerializer.Deserialize<ActResult>(text, FeedView.Json);
            if (result is null || (result.Ok ? string.IsNullOrWhiteSpace(result.Done) : string.IsNullOrWhiteSpace(result.Error))) throw new JsonException();
            return result;
        }
        catch (JsonException e) { throw new BoardException("起動要求の解除結果を取得できませんでした。", e); }
    }

    /// <summary>What the person did: <c>pick:&lt;n&gt;</c>, <c>later</c>, <c>seen</c>, <c>cancel</c> or <c>reply</c> with text. Returns the board's own words when it refuses.</summary>
    public async Task<ActResult> ActAsync(string thread, string action, string text = "", CancellationToken ct = default)
    {
        var body = await WithKey(key => new HttpRequestMessage(HttpMethod.Post, "app/act")
        {
            Content = new FormUrlEncodedContent([new("t", key), new("thread", thread), new("action", action), new("text", text)]),
        }, ct);
        return JsonSerializer.Deserialize<ActResult>(body, FeedView.Json) ?? new ActResult(false, null, "The board sent no answer.");
    }

    /// <summary>
    /// Tell the board this app is running (every minute), so it leaves the pill and the cards to it.
    /// False from a board too old to know the app; it then keeps doing what it did.
    /// </summary>
    public async Task<bool> HelloAsync(int pid, string exe, CancellationToken ct = default)
    {
        try
        {
            await WithKey(key => new HttpRequestMessage(HttpMethod.Post, "app/hello")
            {
                Content = new FormUrlEncodedContent([new("t", key), new("pid", pid.ToString(System.Globalization.CultureInfo.InvariantCulture)), new("exe", exe)]),
            }, ct);
            return true;
        }
        catch (KeyExpiredException)
        {
            return false;
        }
    }

    /// <summary>One of a card's attachments; null when it is not on this PC's board.</summary>
    public async Task<byte[]?> FileAsync(string thread, int n, CancellationToken ct = default)
    {
        var key = await KeyAsync(ct);
        using var res = await Send(() => new HttpRequestMessage(HttpMethod.Get, $"app/file?t={key}&thread={Uri.EscapeDataString(thread)}&n={n}"), ct);
        return res.IsSuccessStatusCode ? await res.Content.ReadAsByteArrayAsync(ct) : null;
    }

    /// <summary>
    /// The board's event stream: yields once for each "changed". Ends when the board closes it (a
    /// restart); throws <see cref="KeyExpiredException"/> when the key is no longer the board's.
    /// </summary>
    public async IAsyncEnumerable<string> EventsAsync([EnumeratorCancellation] CancellationToken ct = default)
    {
        var key = await KeyAsync(ct);
        using var req = new HttpRequestMessage(HttpMethod.Get, $"app/events?t={key}");
        req.Headers.Accept.ParseAdd("text/event-stream");
        using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (res.StatusCode == HttpStatusCode.NotFound)
        {
            ForgetKey();
            throw new KeyExpiredException();
        }
        res.EnsureSuccessStatusCode();
        using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        // The board writes ": beat" every 25 s. Silence for longer than StreamIdle is a board that hangs
        // without closing the socket: give up on this stream so the caller reconnects.
        while (true)
        {
            using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
            idle.CancelAfter(StreamIdle);
            string? line;
            try
            {
                line = await reader.ReadLineAsync(idle.Token);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new BoardUnreachableException(new TimeoutException($"No word from the board for {StreamIdle.TotalSeconds:0} s."));
            }
            if (line is null) yield break;
            if (line.StartsWith("data:", StringComparison.Ordinal)) yield return line[5..].Trim();
        }
    }

    /// <summary>How long the event stream may stay silent, heartbeats included, before it counts as dead.</summary>
    public TimeSpan StreamIdle { get; init; } = TimeSpan.FromSeconds(60);

    private async Task<string> WithKey(Func<string, HttpRequestMessage> make, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            var key = await KeyAsync(ct);
            using var res = await Send(() => make(key), ct);
            if (res.StatusCode == HttpStatusCode.NotFound && attempt == 0)
            {
                ForgetKey();
                continue;
            }
            if (res.StatusCode == HttpStatusCode.NotFound) throw new KeyExpiredException();
            if (!res.IsSuccessStatusCode)
            {
                try
                {
                    using var error = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
                    if (error.RootElement.TryGetProperty("error", out var message) && message.ValueKind == JsonValueKind.String)
                        throw new BoardRefusedException(message.GetString() ?? "The board refused this request.", (int)res.StatusCode,
                            error.RootElement.TryGetProperty("definitive", out var definitive) && definitive.ValueKind == JsonValueKind.True);
                }
                catch (JsonException) { }
                throw new BoardRefusedException($"The board answered {(int)res.StatusCode}.", (int)res.StatusCode);
            }
            return await res.Content.ReadAsStringAsync(ct);
        }
    }

    private async Task<HttpResponseMessage> Send(Func<HttpRequestMessage> make, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(CallTimeout);
        try
        {
            using var req = make();
            var res = await _http.SendAsync(req, timeout.Token);
            await res.Content.LoadIntoBufferAsync(timeout.Token);
            return res;
        }
        catch (HttpRequestException e)
        {
            throw new BoardUnreachableException(e);
        }
        catch (OperationCanceledException e) when (!ct.IsCancellationRequested)
        {
            throw new BoardUnreachableException(e);
        }
    }

    public void Dispose() => _http.Dispose();
}

public sealed class KeyExpiredException() : BoardException("The board restarted.");

public sealed class BoardRefusedException(string message, int status, bool refusedBeforeCommit = false) : BoardException(message)
{
    public int Status { get; } = status;
    /// <summary>The host said, in its own answer, that it refused before committing anything.</summary>
    public bool RefusedBeforeCommit { get; } = refusedBeforeCommit;
    // Validation/conflict responses come from command handling. An authorization or
    // routing failure on a later retry does not prove the original was uncommitted.
    // A plain 429 may come from a gateway after the original committed; only the host's own flag makes it final.
    public bool Definitive => Status is 400 or 409 or 422 || Status == 429 && RefusedBeforeCommit;
}

public sealed class BoardUnreachableException(Exception inner) : BoardException("The board is not answering.", inner);
