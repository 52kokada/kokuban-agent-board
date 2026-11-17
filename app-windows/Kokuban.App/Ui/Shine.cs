using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Kokuban.App.Ui;

/// <summary>
/// The finish of the native buttons and selection (docs/feed-mockup-v2.html): a
/// coloured glow under them, a hairline of light along their top edge, and a sweep of light across on
/// hover. All compositor visuals; the glow is cast by a shape inset by its spread, so it shows only
/// below the element, as CSS's negative spread does.
/// </summary>
public static class Shine
{
    /// <summary>
    /// A rounded shape, drawn into a surface, shown on a sprite whose shadow takes its outline. The
    /// shape is inset by <paramref name="spread"/>, so under an opaque element only the shadow shows.
    /// </summary>
    public sealed class Caster
    {
        private readonly Compositor _c;
        private readonly CompositionRoundedRectangleGeometry _g;
        private readonly CompositionSpriteShape _shape;
        private readonly ShapeVisual _shapes;
        private readonly CompositionVisualSurface _surface;
        private readonly DropShadow _shadow;
        private readonly float _spread;

        public SpriteVisual Visual { get; }

        public Caster(Compositor c, float radius, float spread, Vector3 offset, float blur)
        {
            _c = c;
            _spread = spread;
            _g = c.CreateRoundedRectangleGeometry();
            _g.CornerRadius = new Vector2(Math.Max(0, radius - spread / 2), Math.Max(0, radius - spread / 2));
            _shape = c.CreateSpriteShape(_g);
            _shapes = c.CreateShapeVisual();
            _shapes.Shapes.Add(_shape);
            _surface = c.CreateVisualSurface();
            _surface.SourceVisual = _shapes;
            Visual = c.CreateSpriteVisual();
            Visual.Brush = c.CreateSurfaceBrush(_surface);
            _shadow = c.CreateDropShadow();
            _shadow.Offset = offset;
            _shadow.BlurRadius = blur;
            _shadow.SourcePolicy = CompositionDropShadowSourcePolicy.InheritFromVisualContent;
            Visual.Shadow = _shadow;
        }

        public void Paint(Windows.UI.Color color, float opacity)
        {
            _shape.FillBrush = _c.CreateColorBrush(color);
            _shadow.Color = color;
            _shadow.Opacity = opacity;
        }

        /// <summary>Follow a shape that moves (the gliding selection) every frame.</summary>
        public void Follow(CompositionRoundedRectangleGeometry shape)
        {
            var at = _c.CreateExpressionAnimation("Vector3(s.Offset.X, s.Offset.Y, 0)");
            at.SetReferenceParameter("s", shape);
            Visual.StartAnimation("Offset", at);
            var size = _c.CreateExpressionAnimation("s.Size");
            size.SetReferenceParameter("s", shape);
            Visual.StartAnimation("Size", size);
            _shapes.StartAnimation("Size", size);
            _surface.StartAnimation("SourceSize", size);
            _g.Offset = new Vector2(_spread, _spread);
            var inner = _c.CreateExpressionAnimation("Vector2(Max(0, s.Size.X - d), Max(0, s.Size.Y - d))");
            inner.SetReferenceParameter("s", shape);
            inner.SetScalarParameter("d", 2 * _spread);
            _g.StartAnimation("Size", inner);
        }

        /// <summary>Where the element it glows under is, in the host's coordinates.</summary>
        public void Place(float x, float y, float w, float h)
        {
            var size = new Vector2(w, h);
            Visual.Offset = new Vector3(x, y, 0);
            Visual.Size = size;
            _shapes.Size = size;
            _surface.SourceSize = size;
            _g.Offset = new Vector2(_spread, _spread);
            _g.Size = new Vector2(Math.Max(0, w - 2 * _spread), Math.Max(0, h - 2 * _spread));
        }
    }

    /// <summary>
    /// The glow under a main button, drawn in <paramref name="under"/>: an empty canvas placed beneath
    /// the button in the same layout. It follows the button wherever layout puts it.
    /// </summary>
    public static Action<Windows.UI.Color?> GlowUnder(Canvas under, FrameworkElement target)
    {
        var host = ElementCompositionPreview.GetElementVisual(under);
        // box-shadow: 0 6px 16px -8px <kind>
        // Spread -6 rather than the web's -8: the compositor's blur is softer than a browser's, and the glow read faint.
        var caster = new Caster(host.Compositor, 17, 6, new Vector3(0, 6, 0), 16);
        var container = host.Compositor.CreateContainerVisual();
        container.Children.InsertAtTop(caster.Visual);
        ElementCompositionPreview.SetElementChildVisual(under, container);
        var shown = false;
        void Follow()
        {
            if (!shown || target.ActualWidth <= 0 || target.Visibility != Visibility.Visible) return;
            var p = target.TransformToVisual(under).TransformPoint(new Windows.Foundation.Point(0, 0));
            caster.Place((float)p.X, (float)p.Y, (float)target.ActualWidth, (float)target.ActualHeight);
        }
        target.SizeChanged += (_, _) => Follow();
        target.LayoutUpdated += (_, _) => Follow();
        return color =>
        {
            shown = color is not null;
            container.Opacity = shown ? 1 : 0;
            if (color is { } c) caster.Paint(c, 1);
            Follow();
        };
    }

    /// <summary>
    /// The light on a main button: a hairline along its top edge, a sweep across on hover, and a little
    /// brightness. Answers a switch: a button stops being the main one when the item changes.
    /// </summary>
    public static Action<bool> On(Button b)
    {
        var c = ElementCompositionPreview.GetElementVisual(b).Compositor;
        var root = c.CreateContainerVisual();
        var clip = c.CreateRoundedRectangleGeometry();
        root.Clip = c.CreateGeometricClip(clip);

        // inset 0 1px 0 rgba(255,255,255,.25)
        var line = c.CreateSpriteVisual();
        line.Brush = c.CreateColorBrush(Windows.UI.Color.FromArgb(64, 255, 255, 255));
        root.Children.InsertAtTop(line);

        // linear-gradient(105deg, transparent 30%, rgba(255,255,255,.35) 50%, transparent 70%), sliding across
        var sweep = c.CreateSpriteVisual();
        var g = c.CreateLinearGradientBrush();
        g.StartPoint = new Vector2(0, 0.37f);
        g.EndPoint = new Vector2(1, 0.63f);
        g.ColorStops.Add(c.CreateColorGradientStop(0.30f, Windows.UI.Color.FromArgb(0, 255, 255, 255)));
        g.ColorStops.Add(c.CreateColorGradientStop(0.50f, Windows.UI.Color.FromArgb(89, 255, 255, 255)));
        g.ColorStops.Add(c.CreateColorGradientStop(0.70f, Windows.UI.Color.FromArgb(0, 255, 255, 255)));
        sweep.Brush = g;
        root.Children.InsertAtTop(sweep);
        ElementCompositionPreview.SetElementChildVisual(b, root);

        float w = 0;
        b.SizeChanged += (_, e) =>
        {
            w = (float)e.NewSize.Width;
            var h = (float)e.NewSize.Height;
            var r = (float)Math.Min(h / 2, b.CornerRadius.TopLeft);
            clip.Size = new Vector2(w, h);
            clip.CornerRadius = new Vector2(r, r);
            root.Size = clip.Size;
            line.Size = new Vector2(Math.Max(0, w - 2 * r), 1);
            line.Offset = new Vector3(r, 0, 0);
            sweep.Size = new Vector2(w, h);
            sweep.Offset = new Vector3(-1.2f * w, 0, 0);
        };
        void Slide(float to)
        {
            if (!Motion.Enabled)
            {
                sweep.Offset = new Vector3(-1.2f * w, 0, 0);
                return;
            }
            var a = c.CreateVector3KeyFrameAnimation();
            a.InsertKeyFrame(1, new Vector3(to, 0, 0), Motion.Out(c));
            a.Duration = TimeSpan.FromMilliseconds(700);
            sweep.StartAnimation("Offset", a);
        }
        var lit = false;
        b.PointerEntered += (_, _) =>
        {
            if (lit) Slide(1.2f * w);
        };
        b.PointerExited += (_, _) => Slide(-1.2f * w);
        return on =>
        {
            lit = on;
            root.Opacity = on ? 1 : 0;
            // filter: brightness(1.06) on hover: the button's own hover layer, a touch of white.
            if (on) b.Resources["Fill1"] = new SolidColorBrush(Windows.UI.Color.FromArgb(16, 255, 255, 255));
            else b.Resources.Remove("Fill1");
        };
    }
}
