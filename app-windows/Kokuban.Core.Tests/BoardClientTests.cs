namespace Kokuban.Core.Tests;

public class BoardClientTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public void Parses_the_view_as_feed_ts_defines_it()
    {
        var v = FeedView.Parse(Sample.View);
        Assert.Equal(1, v.Api);
        Assert.Equal("Alex", v.Me);
        Assert.Equal(2, v.Mine.Count);
        var card = v.Mine[0];
        Assert.Equal(Kinds.Decide, card.Kind);
        Assert.Equal(["Yes", "No"], card.Choices.Select(c => c.Label));
        Assert.Equal("pick:1", card.Choices[1].Id);
        Assert.True(card.Reply);
        Assert.Equal(["report.pdf"], card.Files);
        Assert.Null(card.Misaligned);
        Assert.True(v.Mine[1].Misaligned);
        Assert.Equal("d-7", v.Mine[1].Group);
        Assert.Equal(1792190000000, v.Later[0].Until);
        Assert.Equal("ja", v.Later[0].Lang);
        Assert.Equal("Sam", v.Theirs[0].Person);
        Assert.Equal(Kinds.Blocked, v.Theirs[0].Items[0].Kind);
        Assert.Equal("Milo@pc-b", v.Running[0].To);
        Assert.Equal(["port:8894"], v.Projects[0].Sessions[0].Holds);
        Assert.Null(v.Pcs[1].Ms);
        Assert.Equal("an older kokuban: run kokuban update there", v.Pcs[1].Error);
        Assert.Equal("Iris asked Alex: Ship it?", v.History[0].Text);
    }

    [Fact]
    public void A_board_before_api_reads_as_api_0_in_english()
    {
        var v = FeedView.Parse("""{"me":"K","pc":"p","mine":[],"later":[],"theirs":[],"running":[],"projects":[],"pcs":[],"history":[]}""");
        Assert.Equal(0, v.Api);
        Assert.Equal("en", v.Lang);
    }

    [Fact]
    public async Task Reads_the_key_then_the_view()
    {
        await using var board = new FakeBoard();
        await board.StartAsync();
        using var client = new BoardClient(board.Base);
        Assert.Equal(board.Key, await client.KeyAsync(Ct));
        Assert.Equal("Alex", (await client.ViewAsync(Ct)).Me);
    }

    [Fact]
    public async Task An_older_board_gives_its_key_through_the_window_address()
    {
        await using var board = new FakeBoard { Legacy = true };
        await board.StartAsync();
        using var client = new BoardClient(board.Base);
        Assert.Equal(board.Key, await client.KeyAsync(Ct));
        Assert.Equal(2, (await client.ViewAsync(Ct)).Mine.Count);
    }

    [Fact]
    public async Task A_new_key_after_a_restart_is_fetched_without_being_asked()
    {
        await using var board = new FakeBoard();
        await board.StartAsync();
        using var client = new BoardClient(board.Base);
        await client.ViewAsync(Ct);
        var old = client.Key;
        await board.RestartAsync();
        Assert.Equal("Alex", (await client.ViewAsync(Ct)).Me);
        Assert.NotEqual(old, client.Key);
        Assert.Equal(board.Key, client.Key);
    }

    [Fact]
    public async Task Acting_sends_thread_action_and_text_and_returns_the_boards_own_error()
    {
        await using var board = new FakeBoard
        {
            Answer = (thread, action, _) => action == "reply"
                ? """{"ok":false,"error":"This question is on pc-b: answer it there."}"""
                : """{"ok":true,"done":"later"}""",
        };
        await board.StartAsync();
        using var client = new BoardClient(board.Base);
        var later = await client.ActAsync("card:pc-a:12", "later", ct: Ct);
        Assert.True(later.Ok);
        Assert.Equal("later", later.Done);
        var refused = await client.ActAsync("card:pc-b:3", "reply", "Use the blue one", Ct);
        Assert.False(refused.Ok);
        Assert.Equal("This question is on pc-b: answer it there.", refused.Error);
        Assert.Equal(("card:pc-b:3", "reply", "Use the blue one"), board.Acts[1]);
    }

    [Fact]
    public async Task Says_hello_and_fetches_a_cards_file()
    {
        await using var board = new FakeBoard();
        await board.StartAsync();
        using var client = new BoardClient(board.Base);
        const string exe = @"C:\Users\alex\AppData\Local\Kokuban\current\Kokuban.exe";
        Assert.True(await client.HelloAsync(4242, exe, Ct));
        Assert.Equal([(4242, exe)], board.Hellos);
        Assert.Equal("# The plan", System.Text.Encoding.UTF8.GetString((await client.FileAsync("card:pc-a:12", 0, Ct))!));
        Assert.Null(await client.FileAsync("card:pc-b:3", 0, Ct));
    }

    [Fact]
    public async Task No_board_is_a_board_exception_not_a_crash()
    {
        using var client = new BoardClient(new Uri("http://127.0.0.1:1/"));
        await Assert.ThrowsAsync<BoardUnreachableException>(() => client.ViewAsync(Ct));
    }
}
