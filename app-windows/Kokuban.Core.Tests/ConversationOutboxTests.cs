using System.Text.Json;

namespace Kokuban.Core.Tests;

public class ConversationOutboxTests
{
    [Theory]
    [InlineData(400, true)]
    [InlineData(403, false)]
    [InlineData(404, false)]
    [InlineData(409, true)]
    [InlineData(408, false)]
    [InlineData(429, false)]
    [InlineData(500, false)]
    [InlineData(502, false)]
    [InlineData(504, false)]
    public void Only_definitive_refusals_may_discard_an_immutable_retry(int status, bool definitive)
        => Assert.Equal(definitive, new BoardRefusedException("Refused", status).Definitive);

    [Theory]
    [InlineData(429, true, true)]
    [InlineData(429, false, false)]
    [InlineData(502, true, false)]
    public void Only_the_hosts_own_pre_commit_flag_makes_a_429_final(int status, bool flagged, bool definitive)
        => Assert.Equal(definitive, new BoardRefusedException("Busy", status, flagged).Definitive);

    [Fact]
    public void Message_limit_counts_utf8_bytes_like_the_host()
    {
        Assert.True(ConversationRules.Fits(new string('a', ConversationRules.MessageBytes)));
        Assert.False(ConversationRules.Fits(new string('a', ConversationRules.MessageBytes + 1)));
        Assert.True(ConversationRules.Fits(new string('日', 10922)));   // 32,766 bytes
        Assert.False(ConversationRules.Fits(new string('日', 10923)));  // 32,769 bytes
    }

    [Fact]
    public async Task A_full_japanese_message_fits_the_conversation_route_once_form_encoded()
    {
        var text = new string('日', 10922);
        // The view saves the request as an element first (outbox); the client then serializes that element.
        var element = JsonSerializer.SerializeToElement(new { op = "command", pc = "host", command = new { id = Guid.NewGuid(), sessionId = "s", op = "message", text } }, ConversationRules.Json);
        var json = ConversationRules.Serialize(element);
        Assert.Contains("日日日", json);
        Assert.DoesNotContain(@"\u", json);
        var form = await new FormUrlEncodedContent([new("t", new string('k', 32)), new("request", json)]).ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.InRange(form.Length, 90_000, 160_000);
        // A record saved escaped by an earlier build is re-written unescaped as well.
        var legacy = JsonSerializer.SerializeToElement(new { text = "日本" }, FeedView.Json);
        Assert.Contains(@"\u", legacy.GetRawText());
        Assert.Equal("{\"text\":\"日本\"}", ConversationRules.Serialize(legacy));
    }

    [Fact]
    public void Pending_request_survives_reopen_and_confirm_removes_only_its_id()
    {
        var dir = Path.Combine(Path.GetTempPath(), "kokuban-outbox-" + Guid.NewGuid());
        try
        {
            var request = JsonSerializer.SerializeToElement(new { op = "command", pc = "host", command = new { id = Guid.NewGuid(), sessionId = "session", op = "message", text = "Hello" } });
            new ConversationOutbox(dir).Save(request);
            var reopened = new ConversationOutbox(dir);
            Assert.Equal(request.GetRawText(), Assert.Single(reopened.Pending("host", "session")).GetRawText());
            Assert.Empty(reopened.Pending("other", "session"));
            reopened.Save(request); Assert.Single(reopened.Pending("host"));
            reopened.Confirm(request); Assert.Empty(reopened.Pending("host"));
        }
        finally { Directory.Delete(dir, true); }
    }
    [Fact]
    public void Reusing_a_pending_id_for_changed_content_refuses_and_preserves_original()
    {
        var dir = Path.Combine(Path.GetTempPath(), "kokuban-outbox-" + Guid.NewGuid());
        try
        {
            var id = Guid.NewGuid(); var box = new ConversationOutbox(dir);
            JsonElement Request(string text) => JsonSerializer.SerializeToElement(new { op = "launch", pc = "host", launch = new { id, text } });
            box.Save(Request("first")); Assert.Throws<InvalidDataException>(() => box.Save(Request("changed")));
            Assert.Equal(Request("first").GetRawText(), Assert.Single(box.Pending("host")).GetRawText());
        }
        finally { Directory.Delete(dir, true); }
    }
}
