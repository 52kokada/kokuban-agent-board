namespace Kokuban.Core;

// What the pill shows (docs/feed-mockup-v2.html): the pill itself (a dot per kind waiting and
// "4 for you"), the banner for the newest item, and the open card with its pager.

public sealed record PillState(
    /// <summary>One dot per kind that has something waiting, in the order decide, blocked, go, done.</summary>
    IReadOnlyList<string> Kinds,
    string Label,
    Item? Newest,
    /// <summary>The card on show, and where it is among them.</summary>
    Item? Card,
    int Index,
    int Count,
    string Source,
    ItemDetail? Detail);

public static class PillLayout
{
    private static readonly string[] KindOrder = [Kinds.Decide, Kinds.Blocked, Kinds.Go, Kinds.Done];

    /// <summary>The pill for these items, the card at <paramref name="index"/> (clamped).</summary>
    public static PillState Build(FeedView v, int index, Strings t, long now, IReadOnlyDictionary<string, string>? errors = null)
    {
        var all = v.Mine;
        if (all.Count == 0) return new([], "", null, null, 0, 0, "", null);
        var i = Math.Clamp(index, 0, all.Count - 1);
        var x = all[i];
        var kinds = KindOrder.Where(k => all.Any(a => a.Kind == k)).ToList();
        var newest = all.MaxBy(a => a.Ts);
        var label = t.Japanese ? $"{all.Count}{t.ForYouN}" : $"{all.Count} {t.ForYouN}";
        var source = $"· {x.Agent} · {(x.Project.Length > 0 ? x.Project : x.Pc)} · {t.Ago(x.Ts, now)}";
        return new(kinds, label, newest, x, i, all.Count, source, Layout.DetailOf(x, true, t, now, errors));
    }
}
