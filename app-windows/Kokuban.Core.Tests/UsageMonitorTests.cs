using Kokuban.Core;

public class UsageMonitorTests
{
    [Fact]
    public void RejectsRemotePlaybackEvenWhenCalledWithoutAppSettings()
        => Assert.Throws<ArgumentException>(() => new UsageMonitor(AppContext.BaseDirectory, playbackUri: new Uri("https://example.com/status")));

    [Fact]
    public async Task DisposalTerminatesOnlyTheCollectorsItStarted()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "usage-fixture-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var pidPath = Path.Combine(directory, "pid.txt");
        var cancellation = TestContext.Current.CancellationToken;
        var monitor = new UsageMonitor(directory);
        try
        {
            var code = "import {writeFileSync} from 'node:fs'; writeFileSync(" + System.Text.Json.JsonSerializer.Serialize(pidPath) + ",String(process.pid));setInterval(()=>{},1000);";
            await File.WriteAllTextAsync(Path.Combine(directory, "today-usage.mjs"), code, cancellation);
            await File.WriteAllTextAsync(Path.Combine(directory, "live-sessions.mjs"), "setInterval(()=>{},1000);", cancellation);
            monitor.Start();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            while (!File.Exists(pidPath)) await Task.Delay(50, timeout.Token);
            var pid = int.Parse(await File.ReadAllTextAsync(pidPath, cancellation));
            await monitor.DisposeAsync();
            await monitor.DisposeAsync();
            var gone = false;
            try { using var child = System.Diagnostics.Process.GetProcessById(pid); gone = child.HasExited; }
            catch (ArgumentException) { gone = true; }
            Assert.True(gone);
            Assert.Throws<ObjectDisposedException>(monitor.Start);
        }
        finally { await monitor.DisposeAsync(); Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task MissingCollectorsRemainUnknownAndStartIsIdempotent()
    {
        await using var monitor = new UsageMonitor(Path.Combine(AppContext.BaseDirectory, "missing-tools"));
        Assert.Equal("—", monitor.Snapshot.TokenText);
        monitor.Start();
        monitor.Start();
        await Task.Delay(100, TestContext.Current.CancellationToken);
        Assert.Equal(0, monitor.Snapshot.ActiveCount);
        Assert.Empty(monitor.Snapshot.Agents);
    }

    [Fact]
    public async Task RunsNodeCollectorsAndStopsCallbacksOnDisposal()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "usage-fixture-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        try
        {
            await File.WriteAllTextAsync(Path.Combine(directory, "today-usage.mjs"), "console.log(JSON.stringify({day:new Date().toLocaleDateString('en-CA'),observedAt:Date.now(),totalTokens:123,byHost:{codex:123,claude:0,kimi:0},agents:[{id:'fixture',host:'codex',name:'Fixture',tokens:123}]}));", TestContext.Current.CancellationToken);
            await File.WriteAllTextAsync(Path.Combine(directory, "live-sessions.mjs"), "console.log(JSON.stringify({observedAt:Date.now(),sessions:[{id:'fixture',host:'codex',name:'Fixture',state:'working',verified:true,present:true}]}));", TestContext.Current.CancellationToken);
            var monitor = new UsageMonitor(directory);
            monitor.Changed += () => { Interlocked.Increment(ref calls); if (monitor.Snapshot.TokenText == "123" && monitor.Snapshot.ActiveCount == 1) changed.TrySetResult(); };
            try
            {
                monitor.Start();
                await changed.Task.WaitAsync(TimeSpan.FromSeconds(15), TestContext.Current.CancellationToken);
                Assert.Equal("123", Assert.Single(monitor.Snapshot.Agents).TokenText);
            }
            finally { await monitor.DisposeAsync(); }
            var after = calls;
            await Task.Delay(100, TestContext.Current.CancellationToken);
            Assert.Equal(after, calls);
        }
        finally { Directory.Delete(directory, true); }
    }
}
