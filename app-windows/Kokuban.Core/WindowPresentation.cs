namespace Kokuban.Core;

public static class WindowPresentation
{
    // An agent's passive opening is explicit on each invocation, including
    // arguments handed to an already-running app; it never changes user settings.
    public static bool ShouldActivate(IReadOnlyList<string> args, string? passiveEnvironment)
        => !args.Contains("--no-activate") && passiveEnvironment != "1";

    public static bool RejectPassiveView(IReadOnlyList<string> args, string? passiveEnvironment)
        => !ShouldActivate(args, passiveEnvironment) && args.Any(a => a is "--settings" or "--pill" or "--feed");
}
