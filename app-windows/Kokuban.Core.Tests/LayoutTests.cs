namespace Kokuban.Core.Tests;

public class LayoutTests
{
    private const long Now = 1792180060000;
    private static FeedView View() => FeedView.Parse(Sample.View);

    [Fact]
    public void For_you_lists_what_waits_then_finished_then_later_and_selects_the_first()
    {
        var w = new WindowState();
        var l = Layout.Build(View(), w, Strings.En, Now);
        Assert.Equal(["item:card:pc-a:12", "grp:done", "item:task:abc", "grp:later", "item:card:pc-b:3"], l.Rows.Select(r => r.Key));
        Assert.Equal("card:pc-a:12", w.Sel);
        Assert.True(l.Rows[0].Selected);
        Assert.Equal(("Iris", "1m", "Ship it?", "The tests pass."), (l.Rows[0].Top, l.Rows[0].TopRight, l.Rows[0].Title, l.Rows[0].Sub));
        var d = Assert.IsType<ItemDetail>(l.Detail);
        Assert.Equal("Decide", d.KindLabel);
        Assert.Equal("Iris · kokuban · pc-a · 1m", d.Meta);
        Assert.Equal([("pick:0", "Yes", true), ("pick:1", "No", false)], d.Choices.Select(c => (c.Id, c.Label, c.Primary)));
        Assert.Equal("Later", d.LaterLabel);
        Assert.True(d.Reply);
        Assert.Equal(["report.pdf"], d.Files);
        Assert.True(d.Steps[^1].Last);
    }

    [Fact]
    public void A_finished_item_offers_seen_and_no_later()
    {
        var w = new WindowState { Sel = "task:abc" };
        var d = Assert.IsType<ItemDetail>(Layout.Build(View(), w, Strings.En, Now).Detail);
        Assert.Equal([("seen", "Seen", true)], d.Choices.Select(c => (c.Id, c.Label, c.Primary)));
        Assert.Equal("", d.LaterLabel);
        Assert.False(d.Reply);
        Assert.Equal("Disagreement", d.Tag);
        Assert.Equal("Disagreement", Assert.Single(Layout.Build(View(), new WindowState(), Strings.En, Now).Rows, r => r.Key == "item:task:abc").Tag);
        Assert.Equal("意見が分かれています", Layout.DetailOf(View().Mine[1], true, Strings.Ja, Now).Tag);
    }

    [Fact]
    public void Waiting_on_another_person_shows_their_items_without_actions()
    {
        var w = new WindowState { View = Section.Theirs, Person = "Sam" };
        var l = Layout.Build(View(), w, Strings.En, Now);
        Assert.Contains(l.Side, s => s.Key == "nav:theirs:Sam" && s.Label == "Waiting on Sam" && s.Count == "1" && s.Selected);
        var d = Assert.IsType<ItemDetail>(l.Detail);
        Assert.False(d.Mine);
        Assert.Empty(d.Choices);
        Assert.Equal("", d.LaterLabel);
        Assert.False(d.Reply);
    }

    [Fact]
    public void Japanese_names_the_person_first()
    {
        var l = Layout.Build(View(), new WindowState(), Strings.Ja, Now);
        Assert.Contains(l.Side, s => s.Label == "Sam待ち");
        Assert.Equal("あなた宛て", l.Side[0].Label);
    }

    [Fact]
    public void Pcs_leave_out_this_one_and_say_when_one_is_not_answering()
    {
        var l = Layout.Build(View(), new WindowState(), Strings.En, Now);
        var pc = Assert.Single(l.Pcs);
        Assert.Equal(("pc-b", "blocked", "not answering", "an older kokuban: run kokuban update there"), (pc.Label, pc.Kind, pc.Note, pc.Tip));
    }

    [Fact]
    public void A_project_opens_to_its_sessions_and_a_session_shows_what_glance_shows()
    {
        var w = new WindowState { Proj = "kokuban" };
        w.Open.Add("kokuban");
        var l = Layout.Build(View(), w, Strings.En, Now);
        Assert.Contains(l.Side, s => s.Key == "proj:kokuban" && s.Open && s.Selected && s.Count == "1" && s.Dots == "done");
        var sess = Assert.Single(l.Side, s => s.Type == SideType.Session);
        Assert.Equal("", sess.Note);
        Assert.Equal(new ColumnHead("kokuban", "1 sessions"), l.Head);
        var d = Assert.IsType<SessionDetail>(l.Detail);
        Assert.Equal("claude · kokuban-native@native-app", d.Meta);
        Assert.Equal("working · active", d.Status);
        Assert.Equal("port:8894", d.Holds);
        Assert.False(Assert.Single(l.Side, s => s.Key == "nav:you").Selected, "a project selected is not For you selected");
    }

    [Fact]
    public void Only_what_changed_differs_when_a_pc_answers_again()
    {
        // The whole view changes every minute (each PC's at and ms); nothing the window shows may.
        var a = View();
        var b = FeedView.Parse(Sample.View.Replace("\"ms\": 0, \"at\": 1792180000000", "\"ms\": 41, \"at\": 1792180059000"));
        Assert.NotEqual(FeedView.Signature(a), FeedView.Signature(b));
        var la = Layout.Build(a, new WindowState(), Strings.En, Now);
        var lb = Layout.Build(b, new WindowState(), Strings.En, Now);
        Assert.Equal(la.Side, lb.Side);
        Assert.Equal(la.Pcs, lb.Pcs);
        Assert.Equal(la.Rows, lb.Rows);
        Assert.Equal(la.Detail!.Signature, lb.Detail!.Signature);
    }

    [Fact]
    public void A_count_of_nothing_is_not_shown()
    {
        var v = View();
        v.Running.Clear();
        var l = Layout.Build(v, new WindowState { View = Section.Live }, Strings.En, Now);
        Assert.Equal("", Assert.Single(l.Side, s => s.Key == "nav:live").Count);
        Assert.Equal(RowType.Empty, Assert.Single(l.Rows).Type);
        Assert.Null(l.Detail);
    }
}

public class PillLayoutTests
{
    private const long Now = 1792180060000;

    [Fact]
    public void The_pill_has_a_dot_per_kind_waiting_and_a_count()
    {
        var p = PillLayout.Build(FeedView.Parse(Sample.View), 0, Strings.En, Now);
        Assert.Equal(["decide", "done"], p.Kinds);
        Assert.Equal("2 for you", p.Label);
        Assert.Equal("Ship it?", p.Newest!.Title);
        Assert.Equal("· Iris · kokuban · 1m", p.Source);
        Assert.Equal((0, 2), (p.Index, p.Count));
        Assert.Equal([("pick:0", true), ("pick:1", false)], p.Detail!.Choices.Select(c => (c.Id, c.Primary)));
    }

    [Fact]
    public void The_card_index_stays_within_what_waits_and_a_project_less_item_names_its_pc()
    {
        var p = PillLayout.Build(FeedView.Parse(Sample.View), 9, Strings.Ja, Now);
        Assert.Equal(1, p.Index);
        Assert.Equal("2件 あなた宛て", p.Label);
        Assert.Equal("· Milo · pc-b · 3h", p.Source);
    }

    [Fact]
    public void Nothing_waiting_is_no_pill()
    {
        var v = FeedView.Parse(Sample.View);
        v.Mine.Clear();
        var p = PillLayout.Build(v, 0, Strings.En, Now);
        Assert.Null(p.Card);
        Assert.Equal(0, p.Count);
    }
}
