using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;

namespace Kokuban.App.Ui;

public enum IslandShape { Hidden, Pill, Banner, Card }

/// <summary>
/// The black island of the pill: one rounded rectangle drawn by the compositor, whose size and
/// corners spring between the pill (250×36), the banner (380×64) and the card (460×300), with its
/// content clipped to the same shape as it moves. Sizes and timings are the web page's
/// (docs/feed-mockup-v2.html).
/// </summary>
public sealed class Island : Grid
{
    public const float MaxWidth_ = 460, MaxHeight_ = 300;

    public static (float W, float H, float R) SizeOf(IslandShape s) => s switch
    {
        IslandShape.Banner => (380, 64, 26),
        IslandShape.Card => (460, 300, 30),
        _ => (250, 36, 18),
    };

    private readonly Compositor _c;
    private readonly CompositionRoundedRectangleGeometry _shape;
    private readonly Visual _host;
    private readonly Grid _content = new();
    private IslandShape _now = IslandShape.Hidden;

    public Island()
    {
        Width = MaxWidth_;
        Height = MaxHeight_;
        HorizontalAlignment = HorizontalAlignment.Center;
        VerticalAlignment = VerticalAlignment.Top;
        _host = ElementCompositionPreview.GetElementVisual(this);
        _c = _host.Compositor;

        _shape = _c.CreateRoundedRectangleGeometry();
        var (w, h, r) = SizeOf(IslandShape.Pill);
        _shape.Size = new Vector2(w, h);
        _shape.CornerRadius = new Vector2(r, r);
        // Centred: the offset follows the animated width every frame.
        var centre = _c.CreateExpressionAnimation("Vector2((W - g.Size.X) / 2, 0)");
        centre.SetScalarParameter("W", MaxWidth_);
        centre.SetReferenceParameter("g", _shape);
        _shape.StartAnimation("Offset", centre);

        var sprite = _c.CreateSpriteShape(_shape);
        sprite.FillBrush = _c.CreateColorBrush(Windows.UI.Color.FromArgb(255, 0, 0, 0));
        // The hairline that keeps the island's edge crisp on dark backgrounds: 0 0 0 .5px rgba(255,255,255,.08).
        sprite.StrokeBrush = _c.CreateColorBrush(Windows.UI.Color.FromArgb(20, 255, 255, 255));
        sprite.StrokeThickness = 0.5f;
        var shapes = _c.CreateShapeVisual();
        shapes.Size = new Vector2(MaxWidth_, MaxHeight_);
        shapes.Shapes.Add(sprite);
        // The shape is drawn into a surface and shown on a sprite, whose shadow takes the surface's alpha:
        // it follows the island's own outline as it morphs. (A LayerVisual's shadow fills its whole rectangle.)
        var surface = _c.CreateVisualSurface();
        surface.SourceVisual = shapes;
        surface.SourceSize = shapes.Size;
        var island = _c.CreateSpriteVisual();
        island.Size = shapes.Size;
        island.Brush = _c.CreateSurfaceBrush(surface);
        var shadow = _c.CreateDropShadow();
        shadow.BlurRadius = 30;
        shadow.Offset = new Vector3(0, 10, 0);
        shadow.Color = Windows.UI.Color.FromArgb(102, 0, 0, 0);
        shadow.SourcePolicy = CompositionDropShadowSourcePolicy.InheritFromVisualContent;
        island.Shadow = shadow;

        var under = new Grid();
        ElementCompositionPreview.SetElementChildVisual(under, island);
        Children.Add(under);
        Children.Add(_content);
        ElementCompositionPreview.GetElementVisual(_content).Clip = _c.CreateGeometricClip(_shape);

        _host.CenterPoint = new Vector3(MaxWidth_ / 2, 0, 0);
        _host.Opacity = 0;
        _host.Scale = new Vector3(0.6f, 0.6f, 1);
        // XAML owns the visual's Offset (layout); motion uses Translation on top of it.
        ElementCompositionPreview.SetIsTranslationEnabled(this, true);
        _host.Properties.InsertVector3("Translation", new Vector3(0, -60, 0));
        RequestedTheme = ElementTheme.Dark;
    }

    public UIElementCollection Parts => _content.Children;

    public IslandShape Shape => _now;

    /// <summary>Spring to a shape; Hidden shrinks it up and away.</summary>
    public void Morph(IslandShape to)
    {
        if (to == _now) return;
        var from = _now;
        _now = to;
        var reduce = !Motion.Enabled;
        var wasFaded = _faded;
        if (!Native.RevealPillOnHover) _faded = false;
        if (to == IslandShape.Hidden)
        {
            Animate(_host, "Opacity", 0f, 0.25, reduce);
            AnimateVector3(_host, "Scale", new Vector3(0.6f, 0.6f, 1), reduce, Motion.Lively);
            AnimateVector3(_host, "Translation", new Vector3(0, -60, 0), reduce, Motion.Lively);
            return;
        }
        if (wasFaded && from != IslandShape.Hidden && !Native.RevealPillOnHover) Animate(_host, "Opacity", 1f, 0.25, reduce);
        if (from == IslandShape.Hidden)
        {
            Animate(_host, "Opacity", Native.RevealPillOnHover && _faded ? 0f : 1f, 0.25, reduce);
            AnimateVector3(_host, "Scale", Vector3.One, reduce, Motion.Lively);
            AnimateVector3(_host, "Translation", Vector3.Zero, reduce, Motion.Lively);
        }
        var (w, h, r) = SizeOf(to);
        if (reduce)
        {
            _shape.Size = new Vector2(w, h);
            _shape.CornerRadius = new Vector2(r, r);
            return;
        }
        _shape.StartAnimation("Size", Motion.Spring2(_c, new Vector2(w, h), Motion.Settle));
        _shape.StartAnimation("CornerRadius", Motion.Spring2(_c, new Vector2(r, r), Motion.Settle));
    }

    /// <summary>Nearly clear while the pointer is near but not on it, so what is under it stays usable.</summary>
    public void Fade(bool faded)
    {
        // Asked 30 times a second while the pill is up: only a change starts an animation.
        if (faded == _faded) return;
        _faded = faded;
        Animate(_host, "Opacity", _now == IslandShape.Hidden ? 0f : faded ? Native.RevealPillOnHover ? 0f : 0.12f : 1f, 0.25, !Motion.Enabled);
    }

    private bool _faded = Native.RevealPillOnHover;

    private void Animate(Visual v, string property, float to, double seconds, bool reduce)
    {
        if (reduce)
        {
            v.StopAnimation(property);
            if (property == "Opacity") v.Opacity = to;
            return;
        }
        var a = _c.CreateScalarKeyFrameAnimation();
        a.InsertKeyFrame(1, to, _c.CreateCubicBezierEasingFunction(new Vector2(0.22f, 1), new Vector2(0.36f, 1)));
        a.Duration = TimeSpan.FromSeconds(seconds);
        v.StartAnimation(property, a);
    }

    private void AnimateVector3(Visual v, string property, Vector3 to, bool reduce, (float Damping, double Period) spring)
    {
        if (reduce)
        {
            v.StopAnimation(property);
            if (property == "Scale") v.Scale = to;
            else v.Properties.InsertVector3(property, to);
            return;
        }
        v.StartAnimation(property, Motion.Spring3(_c, to, spring));
    }
}
