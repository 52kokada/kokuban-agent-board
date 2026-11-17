using System.Text;
using System.Text.Json;

namespace Kokuban.Core;

/// <summary>Owner-local phone administration; its capability is read from the person's private settings, never from HTTP.</summary>
public sealed class PhoneClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly BoardClient _events;
    private readonly Func<string> _capability;
    public PhoneClient(Uri? baseUri = null, HttpMessageHandler? handler = null, Func<string>? capability = null)
    {
        _http = new HttpClient(handler ?? new SocketsHttpHandler()) { BaseAddress = baseUri ?? BoardClient.DefaultBase, Timeout = TimeSpan.FromSeconds(20) };
        _events = new BoardClient(baseUri);
        _capability = capability ?? ReadCapability;
    }
    private static string ReadCapability()
    {
        var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "kokuban", "settings.json");
        if (!File.Exists(file)) return "";
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var doc = JsonDocument.Parse(stream);
        return doc.RootElement.TryGetProperty("phone", out var p) && p.TryGetProperty("adminSecret", out var s) ? s.GetString() ?? "" : "";
    }
    public async Task<JsonElement> Call(object request, CancellationToken ct = default)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, "phone-admin") { Content = new StringContent(JsonSerializer.Serialize(request), Encoding.UTF8, "application/json") };
        message.Headers.TryAddWithoutValidation("x-kokuban-admin", _capability());
        using var response = await _http.SendAsync(message, ct);
        if (!response.IsSuccessStatusCode) throw new BoardException($"Phone setup was refused ({(int)response.StatusCode}). Check the board and your Windows account.");
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct)); return doc.RootElement.Clone();
    }
    public IAsyncEnumerable<string> Events(CancellationToken ct) => _events.EventsAsync(ct);
    public void Dispose() { _http.Dispose(); _events.Dispose(); }
}
