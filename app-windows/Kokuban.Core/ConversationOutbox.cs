using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Kokuban.Core;

/// <summary>Preserves an immutable request ID across lost responses, window close, and app restart.</summary>
public sealed class ConversationOutbox
{
    private readonly string _directory;
    public ConversationOutbox(string? directory = null)
    {
        _directory = directory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "kokuban", "conversation-outbox");
        Directory.CreateDirectory(_directory);
    }
    private string FileFor(string id) => Path.Combine(_directory, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id))) + ".json");
    public static string Id(JsonElement request) => request.GetProperty(request.GetProperty("op").GetString() == "launch" ? "launch" : "command").GetProperty("id").GetString() ?? throw new InvalidDataException("Missing command ID");
    public void Save(JsonElement request)
    {
        var file = FileFor(Id(request));
        if (File.Exists(file))
        {
            if (File.ReadAllText(file) != request.GetRawText()) throw new InvalidDataException("A pending command ID cannot be changed.");
            return;
        }
        var temporary = file + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            stream.Write(Encoding.UTF8.GetBytes(request.GetRawText())); stream.Flush(true);
        }
        File.Move(temporary, file, false);
    }
    public void Confirm(JsonElement request) => File.Delete(FileFor(Id(request)));
    public IReadOnlyList<JsonElement> Pending(string host, string? sessionId = null)
    {
        var result = new List<JsonElement>();
        foreach (var file in Directory.EnumerateFiles(_directory, "*.json"))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(file)); var request = doc.RootElement;
                if (request.GetProperty("pc").GetString() != host) continue;
                if (sessionId is not null && (!request.TryGetProperty("command", out var command) || command.GetProperty("sessionId").GetString() != sessionId)) continue;
                result.Add(request.Clone());
            }
            catch (Exception e) when (e is JsonException or IOException or InvalidOperationException or KeyNotFoundException) { /* Preserve unreadable records for diagnosis. */ }
        }
        return result;
    }
}
