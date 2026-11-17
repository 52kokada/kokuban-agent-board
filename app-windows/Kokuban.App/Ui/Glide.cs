using System.Numerics;
using Microsoft.UI.Composition;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Hosting;

namespace Kokuban.App.Ui;

/// <summary>
/// One highlight per list that glides to the selection (the web page's animated background): a
/// rounded rectangle drawn by the compositor behind the lines, whose place and size spring to the
/// selected line. A redraw moves it; it is never drawn again.
/// </summary>
public sealed class Glide
{
    private readonly Compositor _c;
    private readonly CompositionRoundedRectangleGeometry _g;
    private readonly CompositionSpriteShape _sprite;
    private readonly ShapeVisual _shapes;
    private readonly ContainerVisual _root;
    private readonly Shine.Caster? _lift;
    private readonly SpriteVisual? _edge;
    private bool _on;
    private Rect _at;

    /// <summary>Draw behind <paramref name="lines"/>, in <paramref name="under"/>: an empty canvas placed under them in the same scrolling content.</summary>
    public Glide(Canvas under, float radius, bool shadow)
    {
        var host = ElementCompositionPreview.GetElementVisual(under);
        _c = host.Compositor;
        _g = _c.CreateRoundedRectangleGeometry();
        _g.CornerRadius = new Vector2(radius, radius);
        _sprite = _c.CreateSpriteShape(_g);
        _shapes = _c.CreateShapeVisual();
        _shapes.Shapes.Add(_sprite);
        _shapes.RelativeSizeAdjustment = Vector2.One;
        _root = _c.CreateContainerVisual();
        _root.RelativeSizeAdjustment = Vector2.One;
        if (shadow)
        {
            // The selected row's lift (docs/feed-mockup-v2.html): 0 8px 20px -8px accent at 70%, and
            // inset 0 1px 0 rgba(255,255,255,.18) along its top.
            _lift = new Shine.Caster(_c, radius, 8, new Vector3(0, 8, 0), 20);
            _lift.Follow(_g);
            _root.Children.InsertAtTop(_lift.Visual);
        }
        _root.Children.InsertAtTop(_shapes);
        if (shadow)
        {
            _edge = _c.CreateSpriteVisual();
            _edge.Brush = _c.CreateColorBrush(Windows.UI.Color.FromArgb(46, 255, 255, 255));
            var at = _c.CreateExpressionAnimation("Vector3(g.Offset.X + r, g.Offset.Y, 0)");
            at.SetReferenceParameter("g", _g);
            at.SetScalarParameter("r", radius);
            _edge.StartAnimation("Offset", at);
            var size = _c.CreateExpressionAnimation("Vector2(Max(0, g.Size.X - 2 * r), 1)");
            size.SetReferenceParameter("g", _g);
            size.SetScalarParameter("r", radius);
            _edge.StartAnimation("Size", size);
            _root.Children.InsertAtTop(_edge);
        }
        _root.Opacity = 0;
        ElementCompositionPreview.SetElementChildVisual(under, _root);
    }

    public void Paint(Windows.UI.Color color)
    {
        _sprite.FillBrush = _c.CreateColorBrush(color);
        _lift?.Paint(color, 0.7f);
    }

    /// <summary>Glide to a line (its rectangle in the canvas's coordinates); the first time it appears there.</summary>
    public void MoveTo(Rect r)
    {
        var offset = new Vector2((float)r.X, (float)r.Y);
        var size = new Vector2((float)r.Width, (float)r.Height);
        if (_on && r == _at) return;
        _at = r;
        if (!_on || !Motion.Enabled)
        {
            _g.StopAnimation("Offset");
            _g.StopAnimation("Size");
            _g.Offset = offset;
            _g.Size = size;
            Show(true);
            return;
        }
        _g.StartAnimation("Offset", Motion.Spring2(_c, offset, Motion.Settle));
        _g.StartAnimation("Size", Motion.Spring2(_c, size, Motion.Settle));
    }

    public void Hide() => Show(false);

    private void Show(bool on)
    {
        if (on == _on) return;
        _on = on;
        if (!Motion.Enabled)
        {
            _root.Opacity = on ? 1 : 0;
            return;
        }
        var a = _c.CreateScalarKeyFrameAnimation();
        a.InsertKeyFrame(1, on ? 1 : 0, Motion.Out(_c));
        a.Duration = TimeSpan.FromMilliseconds(250);
        _root.StartAnimation("Opacity", a);
    }

    /// <summary>Where <paramref name="line"/> is, in <paramref name="canvas"/>'s coordinates.</summary>
    public static Rect Measure(FrameworkElement line, UIElement canvas)
    {
        var p = line.TransformToVisual(canvas).TransformPoint(new Windows.Foundation.Point(0, 0));
        return new Rect(p.X, p.Y, line.ActualWidth, line.ActualHeight);
    }
}

public readonly record struct Rect(double X, double Y, double Width, double Height);
