namespace Kokuban.Core;

public sealed record LaunchSession(string Id, string Name, string Host, string Cwd, bool Live, long Seen, bool CanResume, string Reason, bool Pending = false);
public sealed record SessionCatalog(List<LaunchSession> Sessions, List<string>? Targets = null);
