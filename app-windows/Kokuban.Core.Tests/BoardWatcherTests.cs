using System.Threading.Channels;

namespace Kokuban.Core.Tests;

public class BoardWatcherTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly TimeSpan[] Quick = [TimeSpan.FromMilliseconds(50), TimeSpan.FromMilliseconds(100)];

    private static async Task<T> Next<T>(ChannelReader<T> reader)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        cts.CancelAfter(TimeSpan.FromSeconds(10));
        return await reader.ReadAsync(cts.Token);
    }

    private static async Task Until(Func<bool> ok)
    {
        for (var i = 0; i < 200 && !ok(); i++) await Task.Delay(25, Ct);
        Assert.True(ok());
    }

    [Fact]
    public async Task Publishes_a_view_only_when_it_changed()
    {
        await using var board = new FakeBoard();
        await board.StartAsync();
        using var client = new BoardClient(board.Base);
        await using var watcher = new BoardWatcher(client, Quick);
        var views = Channel.CreateUnbounded<FeedView>();
        watcher.ViewChanged += v => views.Writer.TryWrite(v);
        watcher.Start();

        Assert.Equal("Alex", (await Next(views.Reader)).Me);
        await Until(() => board.Streams == 1);

        board.Changed();
        board.Changed();
        board.ViewJson = Sample.View.Replace("\"Ship it?\"", "\"Ship it now?\"");
        board.Changed();
        var changed = await Next(views.Reader);
        Assert.Equal("Ship it now?", changed.Mine[0].Title);
        await Task.Delay(200, Ct);
        Assert.False(views.Reader.TryRead(out _), "an unchanged view is not published again");
    }

    [Fact]
    public async Task Survives_a_board_restart_with_a_new_key()
    {
        await using var board = new FakeBoard();
        await board.StartAsync();
        using var client = new BoardClient(board.Base);
        await using var watcher = new BoardWatcher(client, Quick);
        var views = Channel.CreateUnbounded<FeedView>();
        var links = Channel.CreateUnbounded<bool>();
        watcher.ViewChanged += v => views.Writer.TryWrite(v);
        watcher.ConnectionChanged += ok => links.Writer.TryWrite(ok);
        watcher.Start();
        await Next(views.Reader);
        Assert.True(await Next(links.Reader));

        board.ViewJson = Sample.View.Replace("\"Ship it?\"", "\"After the restart\"");
        await board.RestartAsync(TimeSpan.FromMilliseconds(400));

        var after = await Next(views.Reader);
        Assert.Equal("After the restart", after.Mine[0].Title);
        Assert.Equal(board.Key, client.Key);
        await Until(() => board.Streams == 1);
        board.ViewJson = Sample.View.Replace("\"Ship it?\"", "\"Live again\"");
        board.Changed();
        Assert.Equal("Live again", (await Next(views.Reader)).Mine[0].Title);
    }

    [Fact]
    public async Task Says_when_the_board_is_gone_and_when_it_is_back()
    {
        await using var board = new FakeBoard();
        await board.StartAsync();
        using var client = new BoardClient(board.Base);
        await using var watcher = new BoardWatcher(client, Quick);
        var links = Channel.CreateUnbounded<bool>();
        watcher.ConnectionChanged += ok => links.Writer.TryWrite(ok);
        watcher.Start();
        Assert.True(await Next(links.Reader));
        var port = board.Port;
        await board.StopAsync();
        Assert.False(await Next(links.Reader));
        Assert.Equal("The board is not answering.", watcher.Problem);
        await board.StartAsync(port);
        Assert.True(await Next(links.Reader));
        Assert.Null(watcher.Problem);
    }

    [Fact]
    public async Task A_silent_stream_counts_as_dead_and_is_opened_again()
    {
        await using var board = new FakeBoard();
        await board.StartAsync();
        // The fake board sends no heartbeat: silence is a hung board.
        using var client = new BoardClient(board.Base) { StreamIdle = TimeSpan.FromMilliseconds(300) };
        await using var watcher = new BoardWatcher(client, Quick);
        watcher.Start();
        await Until(() => board.StreamsOpened >= 3);
    }

    [Fact]
    public async Task A_key_that_never_works_backs_off_instead_of_spinning()
    {
        await using var board = new FakeBoard { AlwaysExpire = true };
        await board.StartAsync();
        using var client = new BoardClient(board.Base);
        await using var watcher = new BoardWatcher(client, [TimeSpan.FromMilliseconds(200)]);
        watcher.Start();
        await Task.Delay(1000, Ct);
        // Each try is two requests (once, then again with a fresh key); about one try per 200 ms.
        Assert.InRange(board.FeedRequests, 2, 24);
    }
}
