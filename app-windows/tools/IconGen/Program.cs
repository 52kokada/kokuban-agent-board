// Renders assets/icon.svg to a multi-size .ico (PNG entries) and a few PNGs for the app.
//   IconGen <icon.svg> <out-dir>
using SkiaSharp;
using Svg.Skia;

if (args.Length != 2)
{
    Console.Error.WriteLine("usage: IconGen <icon.svg> <out-dir>");
    return 2;
}
var (source, outDir) = (args[0], args[1]);
Directory.CreateDirectory(outDir);

using var svg = new SKSvg();
var picture = svg.Load(source) ?? throw new InvalidOperationException($"cannot read {source}");
var bounds = picture.CullRect;

byte[] Render(int size)
{
    using var bitmap = new SKBitmap(new SKImageInfo(size, size, SKColorType.Bgra8888, SKAlphaType.Premul));
    using (var canvas = new SKCanvas(bitmap))
    {
        canvas.Clear(SKColors.Transparent);
        canvas.Scale(size / bounds.Width, size / bounds.Height);
        canvas.DrawPicture(picture, new SKPaint { IsAntialias = true });
    }
    using var image = SKImage.FromBitmap(bitmap);
    return image.Encode(SKEncodedImageFormat.Png, 100).ToArray();
}

int[] icoSizes = [16, 20, 24, 32, 48, 64, 256];
var pngs = icoSizes.Select(Render).ToArray();
using (var ico = new BinaryWriter(File.Create(Path.Combine(outDir, "icon.ico"))))
{
    ico.Write((ushort)0);
    ico.Write((ushort)1);
    ico.Write((ushort)icoSizes.Length);
    var offset = 6 + 16 * icoSizes.Length;
    for (var i = 0; i < icoSizes.Length; i++)
    {
        var s = icoSizes[i];
        ico.Write((byte)(s >= 256 ? 0 : s));
        ico.Write((byte)(s >= 256 ? 0 : s));
        ico.Write((byte)0);
        ico.Write((byte)0);
        ico.Write((ushort)1);
        ico.Write((ushort)32);
        ico.Write(pngs[i].Length);
        ico.Write(offset);
        offset += pngs[i].Length;
    }
    foreach (var png in pngs) ico.Write(png);
}
foreach (var s in new[] { 44, 64, 150, 256 })
    File.WriteAllBytes(Path.Combine(outDir, $"icon-{s}.png"), Render(s));
Console.WriteLine($"icon.ico ({string.Join(", ", icoSizes)}) -> {outDir}");
return 0;
