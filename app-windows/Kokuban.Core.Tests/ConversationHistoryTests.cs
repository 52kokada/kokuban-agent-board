using System.Text.Json;

namespace Kokuban.Core.Tests;

public class ConversationHistoryTests
{
    [Fact]
    public void A_history_page_reads_its_events_and_where_to_load_earlier()
    {
        // The shape src/conversations/store-worker.ts returns for op "history".
        var json = """{"events":[{"seq":49801,"id":"e1","sessionId":"s","ts":1,"kind":"assistant_delta","text":"hi"},{"seq":49802,"id":"e2","sessionId":"s","ts":2,"kind":"tool","data":{"detailId":"e2","truncated":true}}],"before":49801,"hasMore":true}""";
        var page = JsonSerializer.Deserialize<ConversationResponse>(json, FeedView.Json)!;
        Assert.Equal([49801L, 49802L], page.Events.Select(e => e.Seq));
        Assert.Equal(49801, page.Before);
        Assert.True(page.HasMore);
    }

    [Fact]
    public void An_events_page_from_an_older_host_has_no_history_cursor()
    {
        var page = JsonSerializer.Deserialize<ConversationResponse>("""{"events":[]}""", FeedView.Json)!;
        Assert.Null(page.Before);
        Assert.False(page.HasMore);
    }
}
