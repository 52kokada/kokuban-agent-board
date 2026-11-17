namespace Kokuban.Core.Tests;

/// <summary>Reads this PC's running board, read-only. Runs only with KOKUBAN_LIVE=1.</summary>
public class LiveBoardTests
{
    private static bool Live => Environment.GetEnvironmentVariable("KOKUBAN_LIVE") == "1";

    [Fact]
    public async Task Reads_the_live_board()
    {
        Assert.SkipUnless(Live, "set KOKUBAN_LIVE=1 to read this PC's board");
        using var client = new BoardClient();
        var view = await client.ViewAsync(TestContext.Current.CancellationToken);
        Assert.False(string.IsNullOrEmpty(view.Me));
        Assert.Contains(view.Pcs, p => p.Pc == view.Pc);
        TestContext.Current.SendDiagnosticMessage(
            $"api {view.Api}, {view.Me}@{view.Pc}: {view.Mine.Count} mine, {view.Later.Count} later, " +
            $"{view.Theirs.Sum(t => t.Items.Count)} theirs, {view.Running.Count} running, " +
            $"{view.Projects.Sum(p => p.Sessions.Count)} sessions in {view.Projects.Count} projects, {view.Pcs.Count} PCs, {view.History.Count} history");
    }
}
