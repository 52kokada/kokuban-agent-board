namespace Kokuban.Core.Tests;

public class ConversationLaunchTests
{
    [Theory]
    [InlineData("unknown op \"conversations\"")]
    [InlineData("Unknown conversation operation: history")]
    public void A_host_without_shared_agents_is_named_plainly(string message) =>
        Assert.Equal("pc-b runs an older Kokuban without shared agents.", ConversationRules.HostProblem("pc-b", message));

    [Fact]
    public void Other_host_refusals_keep_their_text() =>
        Assert.Equal("The host PC did not answer.", ConversationRules.HostProblem("pc-b", "The host PC did not answer."));

    [Theory]
    [InlineData("", true)]
    [InlineData("Fjord_2-b", true)]
    [InlineData("has space", false)]
    [InlineData("名前", false)]
    public void Agent_names_follow_the_host_rule(string name, bool valid) => Assert.Equal(valid, ConversationRules.ValidName(name));

    [Fact]
    public void A_name_over_forty_characters_is_refused() => Assert.False(ConversationRules.ValidName(new string('a', 41)));
}
