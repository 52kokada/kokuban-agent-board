using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Kokuban.Core.Tests;

/// <summary>The board's app routes (src/app-routes.ts) as a test needs them, on a port of its own.</summary>
public sealed class FakeBoard : IAsyncDisposable
{
    private WebApplication? _app;
    private readonly ConcurrentDictionary<Channel<string>, byte> _streams = new();

    public string Key { get; private set; } = NewKey();
    public int Port { get; private set; }
    public Uri Base => new($"http://127.0.0.1:{Port}/");
    /// <summary>A board from before /app/key: the key only in /app/open's address.</summary>
    public bool Legacy { get; set; }
    public string ViewJson { get; set; } = Sample.View;
    public List<(string Thread, string Action, string Text)> Acts { get; } = [];
    public Func<string, string, string, string>? Answer { get; set; }
    public List<(int Pid, string Exe)> Hellos { get; } = [];
    public int Streams => _streams.Count;
    /// <summary>Every key is wrong: something else on the port, or a board that never agrees.</summary>
    public bool AlwaysExpire { get; set; }
    public int FeedRequests;
    public int StreamsOpened;

    private static string NewKey() => Guid.NewGuid().ToString("N");

    public async Task StartAsync(int port = 0)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
        // A real board that stops drops its streams; it does not wait for them.
        builder.WebHost.UseShutdownTimeout(TimeSpan.FromMilliseconds(100));
        var app = builder.Build();
        app.MapGet("/app/key", (HttpContext c) => Legacy ? Results.NotFound() : Results.Json(new { key = Key, api = 1 }));
        app.MapGet("/app/open", (HttpContext c) => Results.Json(new { url = $"http://127.0.0.1:{Port}/app?t={Key}&as=window" }));
        app.MapGet("/app/feed.json", (HttpContext c) =>
        {
            Interlocked.Increment(ref FeedRequests);
            return c.Request.Query["t"] == Key && !AlwaysExpire ? Results.Text(ViewJson, "application/json") : Results.NotFound();
        });
        app.MapPost("/app/hello", async (HttpContext c) =>
        {
            var form = await c.Request.ReadFormAsync();
            if (form["t"] != Key) return Results.NotFound();
            Hellos.Add((int.Parse(form["pid"]!), form["exe"].ToString()));
            return Results.Json(new { ok = true, every = 60 });
        });
        app.MapGet("/app/file", (HttpContext c) =>
            c.Request.Query["t"] == Key && c.Request.Query["thread"] == "card:pc-a:12" && c.Request.Query["n"] == "0"
                ? Results.Bytes("# The plan"u8.ToArray(), "text/markdown") : Results.NotFound());
        app.MapPost("/app/act", async (HttpContext c) =>
        {
            var form = await c.Request.ReadFormAsync();
            if (form["t"] != Key) return Results.NotFound();
            var (thread, action, text) = (form["thread"].ToString(), form["action"].ToString(), form["text"].ToString());
            Acts.Add((thread, action, text));
            return Results.Text(Answer?.Invoke(thread, action, text) ?? """{"ok":true,"done":"later"}""", "application/json");
        });
        app.MapGet("/app/events", async (HttpContext c) =>
        {
            if (c.Request.Query["t"] != Key)
            {
                c.Response.StatusCode = 404;
                return;
            }
            c.Response.ContentType = "text/event-stream";
            await c.Response.WriteAsync("retry: 2000\n\n");
            await c.Response.Body.FlushAsync();
            var channel = Channel.CreateUnbounded<string>();
            _streams[channel] = 0;
            Interlocked.Increment(ref StreamsOpened);
            try
            {
                await foreach (var line in channel.Reader.ReadAllAsync(c.RequestAborted))
                {
                    await c.Response.WriteAsync(line);
                    await c.Response.Body.FlushAsync();
                }
            }
            catch (OperationCanceledException) { }
            finally
            {
                _streams.TryRemove(channel, out _);
            }
        });
        await app.StartAsync();
        _app = app;
        Port = new Uri(app.Urls.First()).Port;
    }

    public void Changed()
    {
        foreach (var s in _streams.Keys) s.Writer.TryWrite("data: changed\n\n");
    }

    /// <summary>Stop and start again on the same port with a new key, as the board does when it restarts.</summary>
    public async Task RestartAsync(TimeSpan down = default)
    {
        foreach (var s in _streams.Keys) s.Writer.TryComplete();
        await StopAsync();
        if (down > TimeSpan.Zero) await Task.Delay(down);
        Key = NewKey();
        await StartAsync(Port);
    }

    public async Task StopAsync()
    {
        if (_app is null) return;
        foreach (var s in _streams.Keys) s.Writer.TryComplete();
        await _app.StopAsync();
        await _app.DisposeAsync();
        _app = null;
    }

    public async ValueTask DisposeAsync() => await StopAsync();
}

public static class Sample
{
    // The shape src/feed.ts feedView() returns, with api and lang from /app/feed.json.
    public const string View = """
    {
      "api": 1, "lang": "en", "me": "Alex", "pc": "pc-a",
      "mine": [
        { "thread": "card:pc-a:12", "kind": "decide", "person": "Alex", "pc": "pc-a",
          "board": "pc-a", "agent": "Iris", "project": "kokuban", "title": "Ship it?", "body": "The tests pass.",
          "choices": [{ "id": "pick:0", "label": "Yes" }, { "id": "pick:1", "label": "No" }], "reply": true, "ts": 1792180000000,
          "lang": "en", "steps": [{ "text": "Iris: Ship it?", "ts": 1792180000000 }], "files": ["report.pdf"] },
        { "thread": "task:abc", "kind": "done", "person": "Alex", "pc": "pc-b", "board": "pc-a", "agent": "Milo",
          "project": "", "title": "Update the docs", "body": "Done in 3 files.", "choices": [{ "id": "seen", "label": "Seen" }],
          "reply": false, "ts": 1792170000000, "lang": "en", "steps": [], "files": [], "misaligned": true, "group": "d-7" }
      ],
      "later": [
        { "thread": "card:pc-b:3", "kind": "decide", "person": "Alex", "pc": "pc-b", "board": "pc-b", "agent": "Sol",
          "project": "web", "title": "Which logo?", "body": "", "choices": [], "reply": true, "ts": 1792160000000, "lang": "ja",
          "steps": [], "files": [], "until": 1792190000000 }
      ],
      "theirs": [
        { "person": "Sam", "items": [
          { "thread": "card:pc-b:4", "kind": "blocked", "person": "Sam", "pc": "pc-b", "board": "pc-b", "agent": "Sol",
            "project": "web", "title": "Stuck", "body": "", "choices": [{ "id": "cancel", "label": "Cancel task" }], "reply": true,
            "ts": 1792150000000, "lang": "ja", "steps": [], "files": [] } ] }
      ],
      "running": [
        { "thread": "task:def", "from": "Coral@pc-a", "to": "Milo@pc-b", "title": "Build it", "detail": "",
          "state": "accepted", "ts": 1792140000000 }
      ],
      "projects": [
        { "project": "kokuban", "sessions": [
          { "name": "Yuzu", "host": "claude", "project": "kokuban", "where": "kokuban-native@native-app", "status": "working",
            "work": "active", "doing": "Building the app", "next": "", "holds": ["port:8894"], "pc": "pc-a", "person": "Alex" } ] }
      ],
      "pcs": [
        { "pc": "pc-a", "person": "Alex", "ok": true, "ms": 0, "at": 1792180000000 },
        { "pc": "pc-b", "person": "", "ok": false, "ms": null, "at": 0, "error": "an older kokuban: run kokuban update there" }
      ],
      "history": [
        { "id": "card:pc-a:12:asked", "ts": 1792180000000, "kind": "decide", "text": "Iris asked Alex: Ship it?", "pc": "pc-a" }
      ]
    }
    """;
}
