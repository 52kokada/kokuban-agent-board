using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kokuban.Core;

// The board's view of the feed, exactly as src/feed.ts `View` and /app/feed.json define it.

public static class Kinds
{
    public const string Decide = "decide";
    public const string Go = "go";
    public const string Blocked = "blocked";
    public const string Done = "done";
    public const string Note = "note";
}

public sealed record Choice(string Id, string Label);

public sealed record Step(string Text, long Ts);

public class Item
{
    public string Thread { get; init; } = "";
    public string Kind { get; init; } = Kinds.Decide;
    /// <summary>Who it waits on.</summary>
    public string Person { get; init; } = "";
    /// <summary>Where the agent behind it is.</summary>
    public string Pc { get; init; } = "";
    /// <summary>The board that holds it.</summary>
    public string Board { get; init; } = "";
    public string Agent { get; init; } = "";
    public string Project { get; init; } = "";
    public string Title { get; init; } = "";
    public string Body { get; init; } = "";
    public List<Choice> Choices { get; init; } = [];
    /// <summary>The person can answer in words.</summary>
    public bool Reply { get; init; }
    public long Ts { get; init; }
    public string Lang { get; init; } = "en";
    public List<Step> Steps { get; init; } = [];
    public List<string> Files { get; init; } = [];
    /// <summary>The people asked disagree (a card asked of several, answered differently).</summary>
    public bool? Misaligned { get; init; }
    /// <summary>The asker's decision this card belongs to, when one question went to several people.</summary>
    public string? Group { get; init; }
    /// <summary>Only on items in Later: when it comes back.</summary>
    public long? Until { get; init; }
}

public sealed record PersonItems(string Person, List<Item> Items);

public sealed record SessionLine(
    string Name, string Host, string Project, string Where, string Status, string Work,
    string Doing, string Next, List<string> Holds, string Pc, string Person);

public sealed record Running(string Thread, string From, string To, string Title, string Detail, string State, long Ts);

public sealed record ProjectSessions(string Project, List<SessionLine> Sessions);

public sealed record PcLine(string Pc, string Person, bool Ok, double? Ms, long At, string? Error);

public sealed record HistoryLine(string Id, long Ts, string Kind, string Text, string Pc);

public sealed class FeedView
{
    /// <summary>The contract version; 0 from a board older than the app routes' api field.</summary>
    public int Api { get; init; }
    public string Lang { get; init; } = "en";
    public string Me { get; init; } = "";
    public string Pc { get; init; } = "";
    public List<Item> Mine { get; init; } = [];
    public List<Item> Later { get; init; } = [];
    public List<PersonItems> Theirs { get; init; } = [];
    public List<Running> Running { get; init; } = [];
    public List<ProjectSessions> Projects { get; init; } = [];
    public List<PcLine> Pcs { get; init; } = [];
    public List<HistoryLine> History { get; init; } = [];

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static FeedView Parse(string json) =>
        JsonSerializer.Deserialize<FeedView>(json, Json) ?? throw new BoardException("The board sent an empty view.");

    /// <summary>A string that changes exactly when what is shown for this value changes: the app redraws on a change of it only.</summary>
    public static string Signature<T>(T value) => JsonSerializer.Serialize(value, Json);
}

public sealed record ActResult(bool Ok, string? Done, string? Error);

public class BoardException(string message, Exception? inner = null) : Exception(message, inner);
