using System.Net;
using System.Text;
using System.Text.Json;

namespace Kokuban.Core.Tests;

public class PhoneClientTests
{
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request);
    }
    [Fact]
    public async Task Local_admin_capability_is_a_header_and_not_in_the_body_or_response()
    {
        var handler = new Handler(async request =>
        {
            Assert.Equal("owner-private-capability", request.Headers.GetValues("x-kokuban-admin").Single());
            var body = await request.Content!.ReadAsStringAsync(TestContext.Current.CancellationToken);
            Assert.DoesNotContain("owner-private-capability", body);
            Assert.Equal("pair-state", JsonDocument.Parse(body).RootElement.GetProperty("op").GetString());
            return new(HttpStatusCode.OK) { Content = new StringContent("{\"setups\":[]}", Encoding.UTF8, "application/json") };
        });
        using var client = new PhoneClient(new Uri("http://127.0.0.1:47631/"), handler, () => "owner-private-capability");
        var result = await client.Call(new { op = "pair-state" }, TestContext.Current.CancellationToken);
        Assert.Empty(result.GetProperty("setups").EnumerateArray());
    }
    [Fact]
    public async Task Refusal_does_not_echo_provider_or_secret_material()
    {
        using var client = new PhoneClient(new Uri("http://127.0.0.1:47631/"), new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("private server detail") })), () => "owner-private-capability");
        var error = await Assert.ThrowsAsync<BoardException>(() => client.Call(new { op = "pair-create" }, TestContext.Current.CancellationToken));
        Assert.DoesNotContain("private", error.Message); Assert.Contains("403", error.Message);
    }
}
