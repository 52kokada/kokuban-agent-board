namespace Kokuban.Core;

/// <summary>
/// The displayed part of one conversation. Durable history stays on the host; this keeps the view bounded
/// whichever way the person moves: live output trims the oldest entries, and loading earlier pages trims the
/// newest, after which the view is "browsing" older history and live output waits until Latest.
/// </summary>
public sealed class TranscriptWindow<T>(IList<T> items, Func<T, long> seq)
{
    /// <summary>Entries kept while following live output.</summary>
    public int LiveLimit { get; init; } = 1000;
    /// <summary>Entries kept at most, however many earlier pages the person asks for.</summary>
    public int MaxEntries { get; init; } = 5000;
    /// <summary>Earlier pages pushed the newest entries out; new live output is not shown until Latest.</summary>
    public bool Browsing { get; private set; }
    /// <summary>Ask the host for events before this seq to load earlier.</summary>
    public long? Before { get; private set; }
    public bool HasMore { get; private set; }
    private int _limit;

    /// <summary>Shows the newest page, following live output again.</summary>
    public void Open(IEnumerable<T> page, long? before, bool hasMore)
    {
        items.Clear();
        foreach (var item in page) items.Add(item);
        Before = before; HasMore = hasMore; Browsing = false; _limit = LiveLimit;
    }

    /// <summary>Adds an earlier page above what is shown. Over the maximum, the newest entries leave and live output pauses.</summary>
    public void Prepend(IReadOnlyList<T> older, long before, bool hasMore)
    {
        for (var i = older.Count - 1; i >= 0; i--) items.Insert(0, older[i]);
        Before = before; HasMore = hasMore;
        if (items.Count > MaxEntries)
        {
            while (items.Count > MaxEntries) items.RemoveAt(items.Count - 1);
            Browsing = true;
        }
        // Asked-for history stays while live output continues, up to the maximum.
        _limit = Math.Max(_limit, Math.Min(items.Count + 200, MaxEntries));
    }

    /// <summary>A new live entry, shown only while following live output. The oldest entries leave first; they stay loadable.</summary>
    public bool AddLive(T item)
    {
        if (Browsing) return false;
        items.Add(item);
        if (items.Count > _limit)
        {
            while (items.Count > _limit) items.RemoveAt(0);
            Before = seq(items[0]); HasMore = true;
        }
        return true;
    }
}
