using System.Numerics;
using SharpGLTF.Schema2;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// GLB triangle mesh → palette-indexed voxel volume. Fixed detail: the model's longest
/// axis becomes <see cref="PoVoxelStrikeOptions.VoxelResolution"/> voxels.
///
/// Colour comes from the material's base-color factor AND, when the material has one, its
/// base-color <b>texture</b>: the PNG is decoded by <see cref="PngDecoder"/> and sampled at
/// each triangle's centroid UV. Without that step a textured model — which is what any
/// character export is — voxelised to flat white, because its base-color factor is white
/// and all of its actual colour lives in the image. Surface voxels are marked
/// by barycentric sampling at half-voxel pitch (robust for arbitrary triangle soups
/// without a SAT triangle/box test); the interior is closed by an outside flood fill so
/// carved structures read as solid mass, not shells.
/// </summary>
public static class GlbVoxelizer
{
    // One default material until per-file overrides ship: roughly "concrete-ish" so the
    // M2 stress solver has plausible constants to start from.
    private static readonly PvxMaterial DefaultMaterial = new(
        Density: 600f, CompressiveStrength: 5_000_000f, TensileStrength: 2_000_000f);

    /// <summary>
    /// Per-triangle colour source for one primitive: a flat factor, optionally modulated
    /// by a decoded base-color texture sampled at the triangle centroid.
    /// </summary>
    private sealed class ColorSampler
    {
        public required Vector4 Factor { get; init; }
        public PngDecoder.Image? Texture { get; init; }
        public IList<Vector2>? Uv { get; init; }

        public Vector4 Sample(int ia, int ib, int ic)
        {
            if (Texture is null || Uv is null)
            {
                return Factor;
            }
            // Centroid sampling: one colour per triangle, which is all the voxel grid can
            // hold anyway — a voxel is coarser than any triangle worth texturing.
            var u = (Uv[ia].X + Uv[ib].X + Uv[ic].X) / 3f;
            var v = (Uv[ia].Y + Uv[ib].Y + Uv[ic].Y) / 3f;
            // Repeat wrap. glTF's other wrap modes only matter for UVs outside 0..1, which
            // is rare in a baked character atlas, and clamping vs repeating there changes
            // one voxel's colour at worst.
            u -= MathF.Floor(u);
            v -= MathF.Floor(v);
            var x = Math.Clamp((int)(u * Texture.Width), 0, Texture.Width - 1);
            var y = Math.Clamp((int)(v * Texture.Height), 0, Texture.Height - 1);
            var o = (y * Texture.Width + x) * 4;
            // glTF base-color TEXTURES are sRGB-encoded; base-color FACTORS are linear, and
            // the two are multiplied in linear space. The palette this feeds is consumed as
            // three.js vertex colours, which are also linear — so decode here or every
            // textured asset renders washed out next to every untextured one.
            return new Vector4(
                SrgbToLinear(Texture.Rgba[o]) * Factor.X,
                SrgbToLinear(Texture.Rgba[o + 1]) * Factor.Y,
                SrgbToLinear(Texture.Rgba[o + 2]) * Factor.Z,
                (Texture.Rgba[o + 3] / 255f) * Factor.W);
        }

        private static float SrgbToLinear(byte channel)
        {
            var c = channel / 255f;
            return c <= 0.04045f ? c / 12.92f : MathF.Pow((c + 0.055f) / 1.055f, 2.4f);
        }
    }

    public static PvxVolume Voxelize(string glbPath, int resolution, PvxSidecar? overrides = null)
    {
        var model = ModelRoot.Load(glbPath);
        var triangles = CollectTriangles(model);
        if (triangles.Count == 0)
        {
            throw new InvalidDataException("GLB contains no triangle geometry.");
        }
        return Voxelize(triangles, resolution, overrides);
    }

    internal readonly record struct Triangle(Vector3 A, Vector3 B, Vector3 C, Vector4 Color);

    private static List<Triangle> CollectTriangles(ModelRoot model)
    {
        var triangles = new List<Triangle>();
        var scene = model.DefaultScene;
        if (scene is null)
        {
            return triangles;
        }
        // Decoded once per image, not per primitive: a character atlas is a few megabytes
        // and the same texture is shared by every primitive of the mesh.
        var decoded = new Dictionary<SharpGLTF.Schema2.Image, PngDecoder.Image?>();

        foreach (var node in scene.VisualChildren)
        {
            Visit(node);
        }
        return triangles;

        void Visit(Node node)
        {
            if (node.Mesh is not null)
            {
                var world = node.WorldMatrix;
                foreach (var primitive in node.Mesh.Primitives)
                {
                    var positions = primitive.GetVertexAccessor("POSITION")?.AsVector3Array();
                    if (positions is null)
                    {
                        continue;
                    }
                    var sampler = SamplerFor(primitive, decoded);
                    foreach (var (ia, ib, ic) in primitive.GetTriangleIndices())
                    {
                        triangles.Add(new Triangle(
                            Vector3.Transform(positions[ia], world),
                            Vector3.Transform(positions[ib], world),
                            Vector3.Transform(positions[ic], world),
                            sampler.Sample(ia, ib, ic)));
                    }
                }
            }
            foreach (var child in node.VisualChildren)
            {
                Visit(child);
            }
        }
    }

    private static Vector4 BaseColorOf(Material? material)
    {
        var channel = material?.FindChannel("BaseColor");
        return channel?.Color ?? new Vector4(0.72f, 0.72f, 0.75f, 1f);
    }

    /// <summary>
    /// Build the colour source for one primitive. Falls back to the flat factor whenever
    /// anything is missing or unreadable — no texture, no UV set, a JPEG or an interlaced
    /// PNG — so an exotic asset degrades to the old behaviour instead of failing to ingest.
    /// </summary>
    private static ColorSampler SamplerFor(MeshPrimitive primitive,
        Dictionary<SharpGLTF.Schema2.Image, PngDecoder.Image?> cache)
    {
        var factor = BaseColorOf(primitive.Material);
        var channel = primitive.Material?.FindChannel("BaseColor");
        var image = channel?.Texture?.PrimaryImage;
        if (image is null)
        {
            return new ColorSampler { Factor = factor };
        }

        if (!cache.TryGetValue(image, out var bitmap))
        {
            var content = image.Content;
            bitmap = content.IsPng ? PngDecoder.TryDecode(content.Content.Span) : null;
            cache[image] = bitmap;
        }
        if (bitmap is null)
        {
            return new ColorSampler { Factor = factor };
        }

        var set = channel?.TextureCoordinate ?? 0;
        var uv = primitive.GetVertexAccessor($"TEXCOORD_{set}")?.AsVector2Array();
        if (uv is null)
        {
            return new ColorSampler { Factor = factor };
        }
        return new ColorSampler { Factor = factor, Texture = bitmap, Uv = uv };
    }

    internal static PvxVolume Voxelize(IReadOnlyList<Triangle> triangles, int resolution, PvxSidecar? overrides = null)
    {
        var min = new Vector3(float.MaxValue);
        var max = new Vector3(float.MinValue);
        foreach (var t in triangles)
        {
            min = Vector3.Min(min, Vector3.Min(t.A, Vector3.Min(t.B, t.C)));
            max = Vector3.Max(max, Vector3.Max(t.A, Vector3.Max(t.B, t.C)));
        }

        var extent = max - min;
        var maxExtent = MathF.Max(extent.X, MathF.Max(extent.Y, extent.Z));
        if (maxExtent <= 0f)
        {
            throw new InvalidDataException("GLB geometry has zero extent.");
        }
        var voxelSize = maxExtent / resolution;

        var nx = Math.Clamp((int)MathF.Ceiling(extent.X / voxelSize), 1, resolution);
        var ny = Math.Clamp((int)MathF.Ceiling(extent.Y / voxelSize), 1, resolution);
        var nz = Math.Clamp((int)MathF.Ceiling(extent.Z / voxelSize), 1, resolution);

        var cells = new byte[nx * ny * nz];
        var palette = new PaletteBuilder();

        // Material table: sidecar overrides take precedence; the default is the floor.
        var materials = BuildMaterialTable(overrides);

        foreach (var t in triangles)
        {
            var index = palette.IndexOf(t.Color);
            // IndexOf returns a ONE-BASED palette index, because 0 is the empty-cell value
            // in the voxel grid. Entries is a plain zero-based List, so the re-stamp below
            // must subtract one. It did not: every GLB threw IndexOutOfRange on its very
            // first triangle (index 1 into a list of length 1), which meant NO new asset
            // could be ingested at all. It went unnoticed because the sample models were
            // already converted and are cached by content hash, so nothing re-entered this
            // path until a new .glb was dropped in.
            var slot = index - 1;
            // Re-stamp the palette entry's MaterialId from the sidecar when the GLB color
            // matches one of the sidecar's palette overrides. Without this, every palette
            // entry would point at MaterialId=1 and the override table would be inert.
            var remapped = ResolveMaterialId(t.Color, overrides, materials.Count);
            if (remapped != palette.Entries[slot].MaterialId)
            {
                palette.Entries[slot] = palette.Entries[slot] with { MaterialId = remapped };
            }
            MarkTriangle(t, index);
        }

        FillInterior(cells, nx, ny, nz, palette);

        return new PvxVolume
        {
            DimX = nx,
            DimY = ny,
            DimZ = nz,
            Palette = palette.Entries.ToList(),
            Materials = materials,
            Cells = cells,
        };

        static byte ResolveMaterialId(Vector4 color, PvxSidecar? sidecar, int materialCount)
        {
            if (sidecar is null) return 1;
            var tol = sidecar.Tolerance == 0 ? (byte)8 : sidecar.Tolerance;
            foreach (var entry in sidecar.PaletteEntries)
            {
                if (Math.Abs(color.X * 255 - entry.R) <= tol
                    && Math.Abs(color.Y * 255 - entry.G) <= tol
                    && Math.Abs(color.Z * 255 - entry.B) <= tol
                    && Math.Abs(color.W * 255 - entry.A) <= tol)
                {
                    return entry.MaterialId;
                }
            }
            return 1;
        }

        IReadOnlyList<PvxMaterial> BuildMaterialTable(PvxSidecar? sidecar)
        {
            if (sidecar is null || sidecar.Materials.Count == 0)
            {
                return [DefaultMaterial];
            }
            var table = new List<PvxMaterial>(sidecar.Materials.Count);
            foreach (var m in sidecar.Materials.OrderBy(x => x.MaterialId))
            {
                table.Add(new PvxMaterial(
                    m.Density ?? DefaultMaterial.Density,
                    m.CompressiveStrength ?? DefaultMaterial.CompressiveStrength,
                    m.TensileStrength ?? DefaultMaterial.TensileStrength));
            }
            // Pad with the default up to the highest MaterialId so palette entries that
            // point beyond the override range still resolve to something sensible.
            while (table.Count < sidecar.Materials.Count) table.Add(DefaultMaterial);
            return table;
        }

        void MarkTriangle(in Triangle t, byte paletteIndex)
        {
            // Sample pitch of half a voxel guarantees no voxel the triangle crosses is
            // skipped; the step count is capped so one degenerate giant triangle cannot
            // stall ingestion (its voxel coverage is bounded by the grid anyway).
            var maxEdge = MathF.Max((t.B - t.A).Length(), MathF.Max((t.C - t.B).Length(), (t.A - t.C).Length()));
            var steps = Math.Clamp((int)MathF.Ceiling(maxEdge / (voxelSize * 0.5f)), 1, 2 * resolution);
            for (var i = 0; i <= steps; i++)
            {
                for (var j = 0; j <= steps - i; j++)
                {
                    var p = t.A + (t.B - t.A) * (i / (float)steps) + (t.C - t.A) * (j / (float)steps);
                    var v = (p - min) / voxelSize;
                    var x = Math.Clamp((int)v.X, 0, nx - 1);
                    var y = Math.Clamp((int)v.Y, 0, ny - 1);
                    var z = Math.Clamp((int)v.Z, 0, nz - 1);
                    cells[x + y * nx + z * nx * ny] = paletteIndex;
                }
            }
        }
    }

    /// <summary>
    /// Empty cells with no 6-connected path to the grid boundary are enclosed by the
    /// surface shell — fill them so the volume is solid mass. Filled with the average
    /// surface color so a carve reveals plausible "core" rather than a void color.
    /// </summary>
    private static void FillInterior(byte[] cells, int nx, int ny, int nz, PaletteBuilder palette)
    {
        var outside = new bool[cells.Length];
        var queue = new Queue<(int X, int Y, int Z)>();

        for (var z = 0; z < nz; z++)
        {
            for (var y = 0; y < ny; y++)
            {
                for (var x = 0; x < nx; x++)
                {
                    if ((x == 0 || y == 0 || z == 0 || x == nx - 1 || y == ny - 1 || z == nz - 1)
                        && cells[x + y * nx + z * nx * ny] == 0)
                    {
                        var i = x + y * nx + z * nx * ny;
                        if (!outside[i])
                        {
                            outside[i] = true;
                            queue.Enqueue((x, y, z));
                        }
                    }
                }
            }
        }

        Span<(int Dx, int Dy, int Dz)> dirs = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)];
        while (queue.Count > 0)
        {
            var (x, y, z) = queue.Dequeue();
            foreach (var (dx, dy, dz) in dirs)
            {
                int qx = x + dx, qy = y + dy, qz = z + dz;
                if (qx < 0 || qy < 0 || qz < 0 || qx >= nx || qy >= ny || qz >= nz)
                {
                    continue;
                }
                var i = qx + qy * nx + qz * nx * ny;
                if (!outside[i] && cells[i] == 0)
                {
                    outside[i] = true;
                    queue.Enqueue((qx, qy, qz));
                }
            }
        }

        var coreIndex = palette.IndexOf(palette.AverageColor());
        for (var i = 0; i < cells.Length; i++)
        {
            if (cells[i] == 0 && !outside[i])
            {
                cells[i] = coreIndex;
            }
        }
    }

    /// <summary>
    /// Maps RGBA colors to 1-based palette indices, capped at 255 entries (0 = empty on
    /// the wire). Base-color factors keep the palette naturally tiny; on overflow the
    /// nearest existing entry is reused rather than failing the asset.
    /// </summary>
    private sealed class PaletteBuilder
    {
        private readonly List<PvxPaletteEntry> _entries = [];
        private readonly Dictionary<uint, byte> _lookup = [];

        public List<PvxPaletteEntry> Entries => _entries;

        public byte IndexOf(Vector4 color)
        {
            // Quantise to 5 bits per channel before keying. The palette holds 255 entries;
            // a textured character yields thousands of distinct texel colours, and without
            // this the first 255 triangles IN FILE ORDER take every slot (so one sleeve
            // could own the whole palette) and everything else snaps to the nearest of
            // those. Merging near-identical colours first spreads the palette across the
            // whole model, and 32 levels per channel is well beyond what a voxel reads as.
            var r = Quantise(ToByte(color.X));
            var g = Quantise(ToByte(color.Y));
            var b = Quantise(ToByte(color.Z));
            var a = ToByte(color.W);
            var key = (uint)(r << 24 | g << 16 | b << 8 | a);
            if (_lookup.TryGetValue(key, out var existing))
            {
                return existing;
            }
            if (_entries.Count >= 255)
            {
                return Nearest(r, g, b);
            }
            _entries.Add(new PvxPaletteEntry(r, g, b, a, MaterialId: 0));
            var index = (byte)_entries.Count; // 1-based
            _lookup[key] = index;
            return index;
        }

        public Vector4 AverageColor()
        {
            if (_entries.Count == 0)
            {
                return new Vector4(0.6f, 0.6f, 0.62f, 1f);
            }
            float r = 0, g = 0, b = 0;
            foreach (var e in _entries)
            {
                r += e.R; g += e.G; b += e.B;
            }
            var n = _entries.Count * 255f;
            // Darkened: exposed core should read as a cut, not as more painted surface.
            return new Vector4(0.8f * r / n, 0.8f * g / n, 0.8f * b / n, 1f);
        }

        private byte Nearest(byte r, byte g, byte b)
        {
            var best = 1;
            var bestDist = int.MaxValue;
            for (var i = 0; i < _entries.Count; i++)
            {
                var e = _entries[i];
                var dist = (e.R - r) * (e.R - r) + (e.G - g) * (e.G - g) + (e.B - b) * (e.B - b);
                if (dist < bestDist)
                {
                    bestDist = dist;
                    best = i + 1;
                }
            }
            return (byte)best;
        }

        private static byte ToByte(float channel) => (byte)Math.Clamp((int)(channel * 255f + 0.5f), 0, 255);

        /// <summary>Snap to 32 levels, keeping 0 and 255 exact so black and white survive.</summary>
        private static byte Quantise(byte v) => (byte)((v >> 3) * 255 / 31);
    }
}
