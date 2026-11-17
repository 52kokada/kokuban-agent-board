using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Kokuban.Core;

public sealed record ConversationActor(string Pc, string Person);
public sealed record ConversationMessage(string Id, string Text, ConversationActor Actor, string State, string? TurnId);
public sealed record ConversationApproval(string Id, long Epoch, string Kind, string Description, string State, JsonElement? Options, ConversationActor? Actor);
public sealed class Conversation
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Host { get; init; } = "";
    public string Project { get; init; } = "";
    public string Provider { get; init; } = "";
    public string Phase { get; init; } = "";
    public long Epoch { get; init; }
    public long Revision { get; init; }
    public long ControlRevision { get; init; }
    public string? TurnId { get; init; }
    public string? Problem { get; init; }
    public List<ConversationMessage> Messages { get; init; } = [];
    public List<ConversationApproval> Approvals { get; init; } = [];
    public override string ToString() => $"{Name} · {Project}\n{Provider} · {Host} · {Phase}";
}
public sealed record ConversationProject(string Id, string Name);
public sealed record ConversationEvent(long Seq, string Id, string SessionId, long Ts, string Kind, string? Text, ConversationActor? Actor, JsonElement? Data);
public sealed class ConversationResponse
{
    public int Protocol { get; init; }
    public bool Enabled { get; init; }
    public string? Host { get; init; }
    public string? Problem { get; init; }
    public Conversation? Session { get; init; }
    public List<Conversation> Sessions { get; init; } = [];
    public List<ConversationProject> Projects { get; init; } = [];
    public List<ConversationEvent> Events { get; init; } = [];
    /// <summary>history: the oldest seq in this page; ask for events before it to load earlier.</summary>
    public long? Before { get; init; }
    public bool HasMore { get; init; }
}

/// <summary>The host's request rules, mirrored so the person learns of a problem before sending.</summary>
public static class ConversationRules
{
    /// <summary>The host accepts at most this many UTF-8 bytes of message text (src/conversations/contracts.ts).</summary>
    public const int MessageBytes = 32768;
    public static int Bytes(string text) => Encoding.UTF8.GetByteCount(text);
    public static bool Fits(string text) => Bytes(text) <= MessageBytes;
    public static string TooLong(string text) => "Message is too long (32 KB max).";
    /// <summary>Text stays UTF-8 rather than \uXXXX, so a Japanese character costs 3 bytes instead of 6 before form encoding.
    /// The request is form data for a loopback program, never HTML, so relaxed escaping is safe here.</summary>
    public static readonly JsonSerializerOptions Json = new(FeedView.Json) { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public static string Serialize(object request) => JsonSerializer.Serialize(request, Json);
    /// <summary>An agent name the host accepts; empty means the host chooses one.</summary>
    public static bool ValidName(string name) => name.Length == 0 || System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z0-9_-]{1,40}$");
    /// <summary>A host's refusal in the person's words. A PC without shared agents answers its peer route's "unknown op".</summary>
    public static string HostProblem(string host, string message) =>
        message.Contains("unknown op", StringComparison.OrdinalIgnoreCase) || message.Contains("Unknown conversation operation", StringComparison.Ordinal)
            ? $"{host} runs an older Kokuban without shared agents."
            : message;
}
