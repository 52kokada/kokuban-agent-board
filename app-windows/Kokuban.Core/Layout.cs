using System.Globalization;
using System.Text.Json;

namespace Kokuban.Core;

// What the window shows, worked out from the view and where the person is in it, the same way as
// the approved native design (docs/feed-mockup-v2.html). Every entry has a key and value equality, so the
// window can keep what did not change and redraw only what did.

public enum Section { You, Theirs, Live, History }

/// <summary>Where the person is in the window.</summary>
public sealed class WindowState
{
    public Section View { get; set; } = Section.You;
    /// <summary>The person whose items "Waiting on" shows.</summary>
    public string? Person { get; set; }
    /// <summary>The selected item (thread).</summary>
    public string? Sel { get; set; }
    /// <summary>The selected session, "pc/name".</summary>
    public string? Sess { get; set; }
    /// <summary>The selected project.</summary>
    public string? Proj { get; set; }
    /// <summary>Projects open in the sidebar.</summary>
    public HashSet<string> Open { get; } = [];
}

public enum SideType { Nav, Header, Project, Session, Pc }

public sealed record SideEntry(
    string Key, SideType Type, string Label, string Count = "", string Kind = "", string Icon = "",
    bool Selected = false, bool Open = false, string Note = "", string Dots = "", string Tip = "");

public enum RowType { Item, Group, Session, Running, History, Empty }

public sealed record RowEntry(
    string Key, RowType Type, string Kind = "", string Top = "", string TopRight = "", string Title = "",
    string Sub = "", bool Selected = false, bool TopBold = true, string Tag = "");

public sealed record ActionChoice(string Id, string Label, bool Primary);

public sealed record TimelineStep(string Text, string Ago, bool Last);

public abstract record Detail(string Key)
{
    /// <summary>Changes exactly when what the pane shows changes.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string Signature => JsonSerializer.Serialize(this, GetType(), FeedView.Json);
}

public sealed record EmptyDetail(string Title, string Text) : Detail("empty");

public sealed record ItemDetail(
    string Key, string Thread, string Kind, string KindLabel, string Meta, string Tag, string Title, string Body, bool Mine,
    IReadOnlyList<ActionChoice> Choices, string LaterLabel, bool Reply, string ReplyHint, string SendLabel, string Error,
    string FilesLabel, IReadOnlyList<string> Files, string HappenedLabel, IReadOnlyList<TimelineStep> Steps) : Detail(Key);

public sealed record SessionDetail(
    string Key, string Name, string Meta, string Kind, string Status,
    string DoingLabel, string Doing, string NextLabel, string Next, string HoldsLabel, string Holds) : Detail(Key);

public sealed record ColumnHead(string Title, string Note);

public sealed record WindowLayout(
    IReadOnlyList<SideEntry> Side, IReadOnlyList<SideEntry> Pcs, ColumnHead? Head, IReadOnlyList<RowEntry> Rows, Detail? Detail);

public static class Layout
{
    public static string SessionKey(SessionLine s) => $"{s.Pc}/{s.Name}";

    /// <summary>A session's colour: blocked red, waiting amber, working green, otherwise faint.</summary>
    public static string SessionKind(SessionLine s) =>
        s.Work.Contains("blocked") || s.Status.Contains("blocked") ? Kinds.Blocked
        : s.Work.Contains("waiting") || s.Status.Contains("waiting") ? Kinds.Decide
        : s.Status == "working" ? Kinds.Done
        : "idle";

    public static WindowLayout Build(FeedView v, WindowState w, Strings t, long now, IReadOnlyDictionary<string, string>? errors = null)
    {
        errors ??= new Dictionary<string, string>();
        string Away(string pc) => pc.Length > 0 && pc != v.Pc ? pc.Split('.')[0] : "";
        string Whose(SessionLine s) => string.Join(" · ", new[] { Away(s.Pc), s.Person.Length > 0 && s.Person != v.Me ? s.Person : "" }.Where(x => x.Length > 0));

        // -- the sidebar
        var side = new List<SideEntry>();
        bool NavSel(Section s, string? person = null) => w.View == s && w.Sess is null && w.Proj is null && (person is null || w.Person == person);
        side.Add(new("nav:you", SideType.Nav, t.ForYou, Count(v.Mine.Count), Icon: "you", Selected: NavSel(Section.You)));
        foreach (var p in v.Theirs)
            side.Add(new($"nav:theirs:{p.Person}", SideType.Nav, t.WaitingOnPerson(p.Person), Count(p.Items.Count), Icon: "theirs", Selected: NavSel(Section.Theirs, p.Person)));
        side.Add(new("nav:live", SideType.Nav, t.Running, Count(v.Running.Count), Icon: "live", Selected: NavSel(Section.Live)));
        side.Add(new("nav:hist", SideType.Nav, t.History, Icon: "hist", Selected: NavSel(Section.History)));
        side.Add(new("h:projects", SideType.Header, t.Projects));
        foreach (var p in v.Projects)
        {
            var open = w.Open.Contains(p.Project);
            side.Add(new($"proj:{p.Project}", SideType.Project, p.Project.Split('/')[^1], p.Sessions.Count.ToString(CultureInfo.InvariantCulture),
                Selected: w.Proj == p.Project && w.Sess is null, Open: open, Dots: string.Join(",", p.Sessions.Take(5).Select(SessionKind))));
            if (!open) continue;
            foreach (var s in p.Sessions)
                side.Add(new($"sess:{SessionKey(s)}", SideType.Session, s.Name, Kind: SessionKind(s), Selected: w.Sess == SessionKey(s), Note: Away(s.Pc)));
        }
        var pcs = v.Pcs.Where(p => p.Pc != v.Pc)
            .Select(p => new SideEntry($"pc:{p.Pc}", SideType.Pc, p.Pc.Split('.')[0], Kind: p.Ok ? Kinds.Done : Kinds.Blocked,
                Note: p.Ok ? "" : t.Offline, Tip: p.Ok ? "" : p.Error ?? t.Offline))
            .ToList();

        // -- the list and the detail
        var rows = new List<RowEntry>();
        ColumnHead? head = null;
        Detail? detail = null;
        var allSessions = v.Projects.SelectMany(p => p.Sessions).ToList();
        RowEntry ItemRow(Item x) => new($"item:{x.Thread}", RowType.Item, x.Kind, x.Agent, t.Ago(x.Ts, now), x.Title, x.Body, w.Sel == x.Thread,
            Tag: x.Misaligned == true ? t.Disagreement : "");

        if (w.Sess is not null || w.Proj is not null)
        {
            var p = v.Projects.FirstOrDefault(x => x.Project == w.Proj) ?? v.Projects.FirstOrDefault(x => x.Sessions.Any(s => SessionKey(s) == w.Sess));
            var list = p?.Sessions ?? [];
            var s = allSessions.FirstOrDefault(x => SessionKey(x) == w.Sess) ?? list.FirstOrDefault();
            head = new(p?.Project ?? "", $"{list.Count} {t.Sessions}");
            foreach (var x in list)
            {
                rows.Add(new($"sess:{SessionKey(x)}", RowType.Session, SessionKind(x), x.Name, Whose(x),
                    x.Doing.Length > 0 ? x.Doing : x.Where, x.Doing.Length > 0 ? x.Where : "", s is not null && SessionKey(s) == SessionKey(x)));
            }
            if (s is not null)
            {
                detail = new SessionDetail($"sess:{SessionKey(s)}", s.Name, Join(s.Host, s.Where, Whose(s)), SessionKind(s),
                    s.Status + (s.Work.Length > 0 ? $" · {s.Work}" : ""), t.Doing, s.Doing, t.Next, s.Next, t.Holds, string.Join(", ", s.Holds));
            }
        }
        else if (w.View == Section.You)
        {
            var all = v.Mine.Concat(v.Later).ToList();
            if (!all.Any(x => x.Thread == w.Sel)) w.Sel = all.FirstOrDefault()?.Thread;
            rows.AddRange(v.Mine.Where(x => x.Kind != Kinds.Done).Select(ItemRow));
            var done = v.Mine.Where(x => x.Kind == Kinds.Done).ToList();
            if (done.Count > 0)
            {
                rows.Add(new("grp:done", RowType.Group, Title: t.Done));
                rows.AddRange(done.Select(ItemRow));
            }
            if (v.Later.Count > 0)
            {
                rows.Add(new("grp:later", RowType.Group, Title: t.Later));
                rows.AddRange(v.Later.Select(ItemRow));
            }
            // "All clear" shows once, in the detail pane; the list stays empty rather than saying it twice.
            var sel = all.FirstOrDefault(x => x.Thread == w.Sel);
            detail = sel is not null ? ItemDetail(sel, true) : new EmptyDetail(t.AllClear, t.Nothing);
        }
        else if (w.View == Section.Theirs)
        {
            var p = v.Theirs.FirstOrDefault(x => x.Person == w.Person) ?? v.Theirs.FirstOrDefault();
            var list = p?.Items ?? [];
            if (!list.Any(x => x.Thread == w.Sel)) w.Sel = list.FirstOrDefault()?.Thread;
            rows.AddRange(list.Select(ItemRow));
            var sel = list.FirstOrDefault(x => x.Thread == w.Sel);
            detail = sel is not null ? ItemDetail(sel, false) : new EmptyDetail(t.Nobody, "");
        }
        else if (w.View == Section.Live)
        {
            rows.AddRange(v.Running.Select(r => new RowEntry($"run:{r.Thread}", RowType.Running, Kinds.Done, $"{r.From} → {r.To}",
                t.Ago(r.Ts, now), r.Title, r.State + (r.Detail.Length > 0 ? $" · {r.Detail}" : ""))));
            if (v.Running.Count == 0) rows.Add(new("empty", RowType.Empty, Sub: t.NoRunning));
        }
        else
        {
            var culture = CultureInfo.GetCultureInfo(t.Japanese ? "ja-JP" : "en-US");
            rows.AddRange(v.History.Select(h => new RowEntry($"hist:{h.Id}", RowType.History, h.Kind == Kinds.Note ? "idle" : h.Kind,
                DateTimeOffset.FromUnixTimeMilliseconds(h.Ts).ToLocalTime().ToString("g", culture), Away(h.Pc), h.Text, TopBold: false)));
            if (v.History.Count == 0) rows.Add(new("empty", RowType.Empty, Sub: t.NoHistory));
        }
        return new(side, pcs, head, rows, detail);

        ItemDetail ItemDetail(Item x, bool mine) => DetailOf(x, mine, t, now, errors);
    }

    /// <summary>One item as the detail pane and the pill's card show it; only the person's own items have actions.</summary>
    public static ItemDetail DetailOf(Item x, bool mine, Strings t, long now, IReadOnlyDictionary<string, string>? errors = null)
    {
        var choices = x.Choices.Select((c, n) => new ActionChoice(c.Id,
            c.Id == "seen" ? t.Seen : c.Id == "cancel" ? t.Cancel : c.Label, n == 0 && x.Kind != Kinds.Blocked)).ToList();
        return new($"item:{x.Thread}", x.Thread, x.Kind, t.Kind(x.Kind), Join(x.Agent, x.Project, x.Pc, t.Ago(x.Ts, now)),
            x.Misaligned == true ? t.Disagreement : "", x.Title, x.Body, mine,
            mine ? choices : [], mine && x.Kind != Kinds.Done ? t.Later : "", mine && x.Reply, t.Reply, t.Send,
            errors is not null && errors.TryGetValue(x.Thread, out var e) ? e : "",
            t.Files, x.Files, t.Happened, x.Steps.Select((s, i) => new TimelineStep(s.Text, t.Ago(s.Ts, now), i == x.Steps.Count - 1)).ToList());
    }

    // As on the web, a count of nothing is not shown.
    private static string Count(int n) => n == 0 ? "" : n.ToString(CultureInfo.InvariantCulture);

    private static string Join(params string[] parts) => string.Join(" · ", parts.Where(p => p.Length > 0));
}
