namespace Kokuban.Core.Tests;

public class TranscriptWindowTests
{
    private sealed record Entry(long Seq);
    private static (List<Entry> Shown, TranscriptWindow<Entry> Window) Open(long first, long last, bool hasMore)
    {
        var shown = new List<Entry>();
        var window = new TranscriptWindow<Entry>(shown, e => e.Seq);
        window.Open(Range(first, last), first, hasMore);
        return (shown, window);
    }
    private static List<Entry> Range(long first, long last) => [.. Enumerable.Range((int)first, (int)(last - first + 1)).Select(i => new Entry(i))];

    [Fact]
    public void Loading_all_of_a_50k_history_never_shows_more_than_the_maximum_and_reaches_the_start()
    {
        var (shown, window) = Open(49_801, 50_000, hasMore: true);
        var pages = 0;
        while (window.HasMore)
        {
            var before = window.Before!.Value;
            var first = Math.Max(1, before - 200);
            window.Prepend(Range(first, before - 1), first, hasMore: first > 1);
            pages++;
            Assert.True(shown.Count <= window.MaxEntries);
            Assert.Equal(Enumerable.Range((int)shown[0].Seq, shown.Count).Select(i => (long)i), shown.Select(e => e.Seq)); // contiguous, ascending
        }
        Assert.Equal(1, shown[0].Seq);
        Assert.Equal(window.MaxEntries, shown.Count);
        Assert.True(window.Browsing);
        Assert.True(pages >= 249);
    }

    [Fact]
    public void While_browsing_earlier_history_live_output_waits_and_latest_follows_again()
    {
        var (shown, window) = Open(49_801, 50_000, hasMore: true);
        for (var i = 0; i < 30; i++) window.Prepend(Range(window.Before!.Value - 200, window.Before!.Value - 1), window.Before!.Value - 200, true);
        Assert.True(window.Browsing);
        var last = shown[^1];
        Assert.False(window.AddLive(new Entry(50_001)));
        Assert.Equal(last, shown[^1]);
        window.Open(Range(49_802, 50_001), 49_802, true);
        Assert.False(window.Browsing);
        Assert.True(window.AddLive(new Entry(50_002)));
        Assert.Equal(201, shown.Count);
    }

    [Fact]
    public void Live_output_trims_the_oldest_and_keeps_them_loadable()
    {
        var (shown, window) = Open(1, 200, hasMore: false);
        for (long seq = 201; seq <= 1500; seq++) Assert.True(window.AddLive(new Entry(seq)));
        Assert.Equal(window.LiveLimit, shown.Count);
        Assert.Equal(501, shown[0].Seq);
        Assert.Equal(501, window.Before);
        Assert.True(window.HasMore);
    }

    [Fact]
    public void Asked_for_history_survives_live_output_up_to_the_maximum()
    {
        var (shown, window) = Open(1801, 2000, hasMore: true);
        for (var i = 0; i < 4; i++) window.Prepend(Range(window.Before!.Value - 200, window.Before!.Value - 1), window.Before!.Value - 200, true);
        Assert.Equal(1000, shown.Count);
        for (long seq = 2001; seq <= 2150; seq++) window.AddLive(new Entry(seq));
        Assert.Equal(1001, shown[0].Seq); // nothing the person loaded was trimmed by 150 live entries
        Assert.False(window.Browsing);
    }
}
