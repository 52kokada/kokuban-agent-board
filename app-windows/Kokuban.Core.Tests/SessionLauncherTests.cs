using System.Net;
using System.Text;
using Kokuban.Core;

namespace Kokuban.Core.Tests;

public sealed class SessionLauncherTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            request.RequestUri!.AbsolutePath == "/app/key"
                ? Task.FromResult(Response("{\"key\":\"test-key\",\"api\":1}")) : respond(request);
    }
    private static HttpResponseMessage Response(string json) => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    [Fact]
    public async Task Catalog_and_launch_use_authenticated_local_routes_and_exact_identity()
    {
        string? form = null;
        using var client = new BoardClient(handler: new Handler(async req =>
        {
            if (req.RequestUri!.AbsolutePath == "/app/sessions")
            {
                Assert.Contains("t=test-key", req.RequestUri.Query);
                return Response("""{"sessions":[{"id":"exact","name":"楓","host":"claude","cwd":"C:/日本語","live":false,"seen":1,"canResume":true,"reason":""}]}""");
            }
            form = await req.Content!.ReadAsStringAsync(); return Response("""{"ok":true,"done":"起動要求済み"}""");
        }));
        var catalog = await client.SessionsAsync(Ct); Assert.Equal("楓", catalog.Sessions[0].Name);
        Assert.True((await client.LaunchSessionAsync("vscode", "exact", ct: Ct)).Ok);
        Assert.Contains("t=test-key", form); Assert.Contains("id=exact", form); Assert.Contains("target=vscode", form);
    }
    [Theory]
    [InlineData("not json")]
    [InlineData("{\"sessions\":null}")]
    [InlineData("{\"sessions\":[null]}")]
    [InlineData("{}")]
    public async Task Malformed_catalog_is_a_board_error_instead_of_a_UI_exception(string json)
    {
        using var client = new BoardClient(handler: new Handler(_ => Task.FromResult(Response(json))));
        await Assert.ThrowsAsync<BoardException>(() => client.SessionsAsync(Ct));
    }
    [Fact]
    public async Task Malformed_launch_result_is_a_board_error()
    {
        using var client = new BoardClient(handler: new Handler(_ => Task.FromResult(Response("{}"))));
        await Assert.ThrowsAsync<BoardException>(() => client.LaunchSessionAsync("terminal", "exact", ct: Ct));
    }
}
