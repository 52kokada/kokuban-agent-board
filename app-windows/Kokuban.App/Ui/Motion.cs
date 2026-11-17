using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;

namespace Kokuban.App.Ui;

/// <summary>
/// The approved motion design (docs/feed-mockup-v2.html), run by the compositor: a spring that settles
/// with a small overshoot for selection and panels, a livelier one for arrivals and presses; lists
/// that rise in with a 35 ms stagger; items that leave sideways while their space closes; counts
/// that roll. Windows' "Animation effects" off stands everything still.
/// </summary>
public static class Motion
{
    /// <summary>Selection, panels, the island's size: damping 0.75, period 55 ms.</summary>
    public static readonly (float Damping, double Period) Settle = (0.75f, 0.055);

    /// <summary>Arrivals and presses: damping 0.55.</summary>
    public static readonly (float Damping, double Period) Lively = (0.55f, 0.055);

    private static readonly Windows.UI.ViewManagement.UISettings Settings = new();

    // KOKUBAN_REDUCE_MOTION=1 stands still as Windows' setting would, for checking without changing it.
    private static readonly bool Reduce = Environment.GetEnvironmentVariable("KOKUBAN_REDUCE_MOTION") == "1";

    public static bool Enabled => !Reduce && Settings.AnimationsEnabled;

    public static Vector2NaturalMotionAnimation Spring2(Compositor c, Vector2 to, (float Damping, double Period) s)
    {
        var a = c.CreateSpringVector2Animation();
        a.FinalValue = to;
        a.DampingRatio = s.Damping;
        a.Period = TimeSpan.FromSeconds(s.Period);
        return a;
    }

    public static Vector3NaturalMotionAnimation Spring3(Compositor c, Vector3 to, (float Damping, double Period) s)
    {
        var a = c.CreateSpringVector3Animation();
        a.FinalValue = to;
        a.DampingRatio = s.Damping;
        a.Period = TimeSpan.FromSeconds(s.Period);
        return a;
    }

    public static ScalarNaturalMotionAnimation Spring1(Compositor c, float to, (float Damping, double Period) s)
    {
        var a = c.CreateSpringScalarAnimation();
        a.FinalValue = to;
        a.DampingRatio = s.Damping;
        a.Period = TimeSpan.FromSeconds(s.Period);
        return a;
    }

    /// <summary>The web page's --out: cubic-bezier(.22, 1, .36, 1).</summary>
    public static CompositionEasingFunction Out(Compositor c) => c.CreateCubicBezierEasingFunction(new Vector2(0.22f, 1), new Vector2(0.36f, 1));

    private static Visual VisualOf(UIElement e)
    {
        ElementCompositionPreview.SetIsTranslationEnabled(e, true);
        return ElementCompositionPreview.GetElementVisual(e);
    }

    private static void Fly(UIElement e, Vector3 from, Vector3 to, float opacityFrom, float opacityTo, double ms, double delayMs = 0)
    {
        var v = VisualOf(e);
        var c = v.Compositor;
        var tr = c.CreateVector3KeyFrameAnimation();
        tr.InsertKeyFrame(0, from);
        tr.InsertKeyFrame(1, to, Out(c));
        tr.Duration = TimeSpan.FromMilliseconds(ms);
        var op = c.CreateScalarKeyFrameAnimation();
        op.InsertKeyFrame(0, opacityFrom);
        op.InsertKeyFrame(1, opacityTo, Out(c));
        op.Duration = tr.Duration;
        if (delayMs > 0)
        {
            tr.DelayTime = op.DelayTime = TimeSpan.FromMilliseconds(delayMs);
            tr.DelayBehavior = op.DelayBehavior = AnimationDelayBehavior.SetInitialValueBeforeDelay;
        }
        v.StartAnimation("Translation", tr);
        v.StartAnimation("Opacity", op);
    }

    /// <summary>A list arrives (blur fade): each line rises 6 px and fades in over 440 ms, 35 ms after the one above.</summary>
    public static void Enter(UIElement e, int index, double rise = 6, double ms = 440, double stagger = 35)
    {
        if (!Enabled) return;
        Fly(e, new Vector3(0, (float)rise, 0), Vector3.Zero, 0, 1, ms, Math.Min(index, 10) * stagger);
    }

    /// <summary>Something new (animated list): it springs in from slightly small and slightly above.</summary>
    public static void Arrive(UIElement e)
    {
        if (!Enabled || e is not FrameworkElement fe) return;
        var v = VisualOf(e);
        var c = v.Compositor;
        v.CenterPoint = new Vector3((float)fe.ActualWidth / 2, 0, 0);
        v.Scale = new Vector3(0.9f, 0.9f, 1);
        v.StartAnimation("Scale", Spring3(c, Vector3.One, Lively));
        Fly(e, new Vector3(0, -6, 0), Vector3.Zero, 0, 1, 450);
    }

    /// <summary>What the person acted on leaves sideways (300 ms); its space closes once it is removed.</summary>
    public static Task Leave(UIElement e)
    {
        if (!Enabled) return Task.CompletedTask;
        Fly(e, Vector3.Zero, new Vector3(24, 0, 0), 1, 0, 300);
        return Task.Delay(300);
    }

    /// <summary>Lines folding away as their project closes (280 ms).</summary>
    public static Task Fold(IEnumerable<UIElement> lines)
    {
        if (!Enabled) return Task.CompletedTask;
        foreach (var e in lines) Fly(e, Vector3.Zero, new Vector3(0, -4, 0), 1, 0, 200);
        return Task.Delay(220);
    }

    /// <summary>Stand still where layout put it, at full opacity.</summary>
    public static void Reset(UIElement e)
    {
        var v = VisualOf(e);
        v.StopAnimation("Translation");
        v.StopAnimation("Opacity");
        v.Properties.InsertVector3("Translation", Vector3.Zero);
        v.Opacity = 1;
    }

    /// <summary>Put back what started to leave, when the board refused.</summary>
    public static void Return(UIElement e)
    {
        if (!Enabled) return;
        Fly(e, new Vector3(24, 0, 0), Vector3.Zero, 0, 1, 300);
    }

    /// <summary>The pill's card slides in from the side it comes from (350 ms, 18 px).</summary>
    public static void Swap(UIElement e, bool fromLeft)
    {
        if (!Enabled) return;
        Fly(e, new Vector3(fromLeft ? -18 : 18, 0, 0), Vector3.Zero, 0, 1, 350);
    }

    /// <summary>A count rolls to its new value: up when it grew, down when it shrank.</summary>
    public static void Roll(UIElement e, bool up)
    {
        if (!Enabled || e is not FrameworkElement fe) return;
        var v = VisualOf(e);
        var h = (float)Math.Max(10, fe.ActualHeight) * 0.7f;
        v.Properties.InsertVector3("Translation", new Vector3(0, up ? h : -h, 0));
        v.StartAnimation("Translation", Spring3(v.Compositor, Vector3.Zero, Lively));
        var op = v.Compositor.CreateScalarKeyFrameAnimation();
        op.InsertKeyFrame(0, 0);
        op.InsertKeyFrame(1, 1, Out(v.Compositor));
        op.Duration = TimeSpan.FromMilliseconds(300);
        v.StartAnimation("Opacity", op);
    }

    /// <summary>Turn to an angle with the settling spring (the project chevron).</summary>
    public static void Turn(FrameworkElement e, float degrees)
    {
        var v = VisualOf(e);
        v.CenterPoint = new Vector3((float)e.ActualWidth / 2, (float)e.ActualHeight / 2, 0);
        if (!Enabled)
        {
            v.StopAnimation("RotationAngleInDegrees");
            v.RotationAngleInDegrees = degrees;
            return;
        }
        v.StartAnimation("RotationAngleInDegrees", Spring1(v.Compositor, degrees, Settle));
    }

    /// <summary>A button sinks to 94% while pressed and springs back on release.</summary>
    public static void Pressable(Button b)
    {
        void To(float s)
        {
            var v = VisualOf(b);
            v.CenterPoint = new Vector3((float)b.ActualWidth / 2, (float)b.ActualHeight / 2, 0);
            if (!Enabled)
            {
                v.Scale = Vector3.One;
                return;
            }
            v.StartAnimation("Scale", Spring3(v.Compositor, new Vector3(s, s, 1), s < 1 ? (0.9f, 0.03) : Lively));
        }
        b.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, _) => To(0.94f)), true);
        b.AddHandler(UIElement.PointerReleasedEvent, new PointerEventHandler((_, _) => To(1)), true);
        b.AddHandler(UIElement.PointerCaptureLostEvent, new PointerEventHandler((_, _) => To(1)), true);
        b.AddHandler(UIElement.PointerExitedEvent, new PointerEventHandler((_, _) => To(1)), true);
    }
}
