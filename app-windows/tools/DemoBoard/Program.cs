// A stand-in board with the mockup's items (docs/feed-mockup-v2.html), for trying the app without
// touching the live one. Its agents have made-up names and every title starts with [Demo], so none of
// it can be taken for the real board. It answers the app routes and acts like the board: Later moves an item to
// Later, Seen and a choice clear it, a reply to a hand-off that stayed here is refused.
//
//   dotnet run --project tools/DemoBoard -- [--port 47690] [--arrive 45]
//   then start the app with KOKUBAN_PORT=47690
//
// --arrive N adds a new question every N seconds (an arrival, for the pill and the motion).
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;

var port = Opt("--port") ?? "47690";
var arrive = int.TryParse(Opt("--arrive"), out var n) ? n : 0;
var key = Guid.NewGuid().ToString("N");
var now = () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
var gate = new Lock();
var streams = new List<Channel<string>>();
var mine = new List<JsonObject>();
var later = new List<JsonObject>();
var t0 = now();

JsonObject Item(string thread, string kind, string agent, string pc, string project, string title, string body, string[] choices, bool reply, long ago, string[] steps, string[]? files = null) => new()
{
    ["thread"] = thread, ["kind"] = kind, ["person"] = "Alex", ["pc"] = pc, ["board"] = "pc-a", ["agent"] = agent,
    // Every made-up item says so, so it is never taken for a real question.
    ["project"] = project, ["title"] = $"[Demo] {title}", ["body"] = body,
    ["choices"] = new JsonArray(choices.Select((c, i) => (JsonNode)new JsonObject
    {
        ["id"] = c == "Seen" ? "seen" : c == "Cancel task" ? "cancel" : $"pick:{i}", ["label"] = c,
    }).ToArray()),
    ["reply"] = reply, ["ts"] = t0 - ago, ["lang"] = "en",
    ["steps"] = new JsonArray(steps.Select((s, i) => (JsonNode)new JsonObject { ["text"] = s, ["ts"] = t0 - ago * (steps.Length - i) / steps.Length }).ToArray()),
    ["files"] = new JsonArray((files ?? []).Select(f => (JsonNode)f).ToArray()),
};

mine.Add(Item("card:pc-a:1", "decide", "Ada", "pc-b", "acme", "Ship the booking fix to production?",
    "Tests pass on keeper-pc. The deploy waits for your yes.", ["Deploy", "Not yet"], true, 120_000,
    ["Alex asked Ada to fix double bookings", "Ada pushed a3f19c2 to acme", "Tests passed on keeper-pc", "Asked you to approve the deploy"], ["deploy-plan.md"]));
mine.Add(Item("task:alder-1", "blocked", "Ben", "keeper-pc", "acme", "Blocked 42 min: needs the Stripe test key",
    "Reply with the key or where to find it, and Ben carries on.", ["Cancel task"], true, 42 * 60_000, ["Gus asked Ben", "blocked: needs the Stripe test key"]));
mine.Add(Item("card:pc-a:2", "go", "Sam", "pc-b", "web", "Customer list cleanup: start it?",
    "Held 4 hours while you were away, so it waits for your go.", ["Start", "Hold"], true, 4 * 3_600_000, []));
// One question asked of both Alex and Sam, answered differently: the disagreement label.
mine[^1]["misaligned"] = true;
mine[^1]["group"] = "d-1";
mine.Add(Item("task:brook-1", "done", "Cleo", "pc-b", "acme", "Handover translation finished",
    "English version ready for the Slack thread.", ["Seen"], false, 12 * 60_000, ["Gus asked Cleo", "done: English version ready"]));

JsonObject Session(string name, string pc, string person, string project, string status, string work, string doing) => new()
{
    ["name"] = name, ["host"] = "claude", ["project"] = project, ["where"] = $"{project}@main", ["status"] = status, ["work"] = work,
    ["doing"] = doing, ["next"] = "", ["holds"] = new JsonArray(), ["pc"] = pc, ["person"] = person,
};

JsonObject View()
{
    lock (gate)
    {
        var order = new Dictionary<string, int> { ["decide"] = 0, ["blocked"] = 1, ["go"] = 2, ["done"] = 3 };
        var m = mine.OrderBy(i => order[(string)i["kind"]!]).ThenByDescending(i => (long)i["ts"]!).Select(i => (JsonNode)i.DeepClone()).ToArray();
        return new JsonObject
        {
            ["api"] = 1, ["lang"] = Opt("--lang") ?? "en", ["me"] = "Alex", ["pc"] = "pc-a",
            ["mine"] = new JsonArray(m),
            ["later"] = new JsonArray(later.Select(i => (JsonNode)i.DeepClone()).ToArray()),
            ["theirs"] = new JsonArray(new JsonObject
            {
                ["person"] = "Sam",
                ["items"] = new JsonArray(
                    Item("card:pc-b:7", "decide", "Eve", "pc-b", "web", "Which logo for the deck?", "Two options attached.", ["Blue", "Orange"], true, 30 * 60_000, []),
                    Item("card:pc-b:8", "go", "Finn", "pc-b", "acme", "Publish the article UI change?", "", ["Publish"], true, 3 * 3_600_000, [])),
            }),
            ["running"] = new JsonArray(
                new JsonObject { ["thread"] = "task:r1", ["from"] = "Gus@pc-a", ["to"] = "Jo@pc-b", ["title"] = "Translate the handover", ["detail"] = "", ["state"] = "accepted", ["ts"] = t0 - 600_000 },
                new JsonObject { ["thread"] = "task:r2", ["from"] = "Hal@pc-a", ["to"] = "Ivy@keeper-pc", ["title"] = "Review slice A", ["detail"] = "halfway", ["state"] = "accepted", ["ts"] = t0 - 1_800_000 }),
            ["projects"] = new JsonArray(
                new JsonObject { ["project"] = "example-org/automation", ["sessions"] = new JsonArray(
                    Session("Gus", "pc-a", "Alex", "automation", "working", "active", "Reviewing the native app"),
                    Session("Hal", "pc-a", "Alex", "automation", "waiting", "waiting", "Grill on the mesh"),
                    Session("Ivy", "keeper-pc", "Alex", "automation", "working", "active", "Review slice A")) },
                new JsonObject { ["project"] = "acme", ["sessions"] = new JsonArray(
                    Session("Ada", "pc-b", "Sam", "acme", "working", "active", "Booking fix"),
                    Session("Ben", "keeper-pc", "Alex", "acme", "idle", "blocked", "Needs the Stripe test key")) }),
            ["pcs"] = new JsonArray(
                new JsonObject { ["pc"] = "pc-a", ["person"] = "Alex", ["ok"] = true, ["ms"] = 0, ["at"] = now() },
                new JsonObject { ["pc"] = "pc-b", ["person"] = "Sam", ["ok"] = true, ["ms"] = 300, ["at"] = now() },
                new JsonObject { ["pc"] = "keeper-pc", ["person"] = "Alex", ["ok"] = false, ["ms"] = null, ["at"] = 0, ["error"] = "timed out" }),
            ["history"] = new JsonArray(
                new JsonObject { ["id"] = "h1", ["ts"] = t0 - 120_000, ["kind"] = "decide", ["text"] = "Ada asked Alex: Ship the booking fix to production?", ["pc"] = "pc-a" },
                new JsonObject { ["id"] = "h2", ["ts"] = t0 - 720_000, ["kind"] = "done", ["text"] = "Gus → Cleo: Translate the handover (done)", ["pc"] = "pc-b" }),
        };
    }
}

void Changed()
{
    lock (gate) foreach (var s in streams) s.Writer.TryWrite("data: changed\n\n");
}

var app = WebApplication.CreateSlimBuilder(args);
app.WebHost.UseUrls($"http://127.0.0.1:{port}");
var web = app.Build();
web.MapGet("/app/key", () => Results.Json(new { key, api = 1 }));
web.MapGet("/app/open", () => Results.Json(new { url = $"http://127.0.0.1:{port}/app?t={key}&as=window" }));
web.MapGet("/app/feed.json", (HttpContext c) => c.Request.Query["t"] == key ? Results.Text(View().ToJsonString(), "application/json") : Results.NotFound());
web.MapPost("/app/hello", async (HttpContext c) =>
{
    var f = await c.Request.ReadFormAsync();
    if (f["t"] != key) return Results.NotFound();
    Console.WriteLine($"hello from {f["pid"]} {f["exe"]}");
    return Results.Json(new { ok = true, every = 60 });
});
web.MapGet("/app/file", (HttpContext c) =>
    c.Request.Query["t"] == key && c.Request.Query["thread"] == "card:pc-a:1" && c.Request.Query["n"] == "0"
        ? Results.Text("# Deploy plan\n\n1. Tag a3f19c2.\n2. Deploy to production.\n3. Watch the bookings for an hour.\n", "text/markdown")
        : Results.NotFound());
web.MapPost("/app/act", async (HttpContext c) =>
{
    var f = await c.Request.ReadFormAsync();
    if (f["t"] != key) return Results.NotFound();
    string thread = f["thread"]!, action = f["action"]!, text = f["text"]!;
    string? error = null, done = action;
    lock (gate)
    {
        var item = mine.FirstOrDefault(i => (string)i["thread"]! == thread) ?? later.FirstOrDefault(i => (string)i["thread"]! == thread);
        if (item is null) error = "This question is gone.";
        else if (action == "later")
        {
            mine.Remove(item);
            item["until"] = now() + 7_200_000;
            later.Add(item);
        }
        else if (action == "reply" && thread.StartsWith("task:")) error = "This hand-off stayed on this PC.";
        else if (action == "reply" && text.Trim().Length == 0) error = "Type something first.";
        else
        {
            mine.Remove(item);
            later.Remove(item);
            done = action == "reply" ? "answered" : action;
        }
    }
    Changed();
    return Results.Json(error is null ? new { ok = true, done } : (object)new { ok = false, error });
});
web.MapGet("/app/events", async (HttpContext c) =>
{
    if (c.Request.Query["t"] != key) return Results.NotFound();
    c.Response.ContentType = "text/event-stream";
    await c.Response.WriteAsync("retry: 2000\n\n");
    await c.Response.Body.FlushAsync();
    var ch = Channel.CreateUnbounded<string>();
    lock (gate) streams.Add(ch);
    try
    {
        using var beat = new PeriodicTimer(TimeSpan.FromSeconds(25));
        var next = beat.WaitForNextTickAsync(c.RequestAborted).AsTask();
        while (!c.RequestAborted.IsCancellationRequested)
        {
            var read = ch.Reader.WaitToReadAsync(c.RequestAborted).AsTask();
            if (await Task.WhenAny(read, next) == next)
            {
                await c.Response.WriteAsync(": beat\n\n");
                next = beat.WaitForNextTickAsync(c.RequestAborted).AsTask();
            }
            while (ch.Reader.TryRead(out var line)) await c.Response.WriteAsync(line);
            await c.Response.Body.FlushAsync();
        }
    }
    catch (OperationCanceledException) { }
    finally
    {
        lock (gate) streams.Remove(ch);
    }
    return Results.Empty;
});

if (arrive > 0)
{
    _ = Task.Run(async () =>
    {
        var k = 100;
        while (true)
        {
            await Task.Delay(TimeSpan.FromSeconds(arrive));
            lock (gate) mine.Add(Item($"card:pc-a:{++k}", "decide", "Dan", "pc-a", "automation",
                $"Merge step {k - 100} of the shared workspace?", "Ivy passed the review.", ["Merge", "Wait"], true, -(now() - t0), []));
            Changed();
        }
    });
}

Console.WriteLine($"demo board on http://127.0.0.1:{port}  (start the app with KOKUBAN_PORT={port})");
web.Run();

string? Opt(string name)
{
    var a = Environment.GetCommandLineArgs();
    var i = Array.IndexOf(a, name);
    return i >= 0 && i + 1 < a.Length ? a[i + 1] : null;
}
