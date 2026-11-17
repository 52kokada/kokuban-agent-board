using System.Diagnostics;

// PATH-scoped adapter: existing Git/auth stay untouched. The pre-push hook owns approval.
var realGit = Environment.GetEnvironmentVariable("KOKUBAN_CHIEF_REAL_GIT");
if (string.IsNullOrEmpty(realGit) || !Path.IsPathFullyQualified(realGit)) return 70;
if (args.Contains("push", StringComparer.OrdinalIgnoreCase))
{
    var expected = Environment.GetEnvironmentVariable("KOKUBAN_CHIEF_GIT_CONFIG");
    var count = Environment.GetEnvironmentVariable("GIT_CONFIG_COUNT");
    var actual = count + "\n";
    if (!int.TryParse(count, out var n) || n < 1 || n > 101) return Refuse();
    for (var i = 0; i < n; i++) actual += Environment.GetEnvironmentVariable($"GIT_CONFIG_KEY_{i}") + "\n" + Environment.GetEnvironmentVariable($"GIT_CONFIG_VALUE_{i}") + "\n";
    if (actual != expected || args.Any(a => a.Equals("--no-verify", StringComparison.OrdinalIgnoreCase)
        || a.Contains("core.hooksPath", StringComparison.OrdinalIgnoreCase)
        || a.Contains("GIT_CONFIG", StringComparison.OrdinalIgnoreCase))) return Refuse();
}
try
{
    var info = new ProcessStartInfo(realGit) { UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    foreach (var arg in args) info.ArgumentList.Add(arg);
    using var child = Process.Start(info);
    if (child is null) return 70;
    _ = Task.Run(async () => { try { await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream); child.StandardInput.Close(); } catch (IOException) { } });
    var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
    var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
    child.WaitForExit();
    Task.WaitAll(output, error);
    return child.ExitCode;
}
catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException) { return 70; }

static int Refuse() { Console.Error.WriteLine("Chief Git push refuses hook bypasses or altered Git configuration. Use a plain push for approval."); return 77; }
