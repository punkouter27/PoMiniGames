using System.Buffers.Binary;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// A voxel volume ready for serialization: palette-indexed cells plus the material
/// constants the client physics needs. Index 0 is always "empty"; palette entries are
/// 1-based on the wire (entry i in <see cref="Palette"/> is written for index i+1).
/// </summary>
public sealed class PvxVolume
{
    public required int DimX { get; init; }
    public required int DimY { get; init; }
    public required int DimZ { get; init; }

    /// <summary>RGBA + material id per palette entry (max 255 entries; index 0 = empty is implicit).</summary>
    public required IReadOnlyList<PvxPaletteEntry> Palette { get; init; }

    public required IReadOnlyList<PvxMaterial> Materials { get; init; }

    /// <summary>
    /// One palette index per cell, X fastest, then Y, then Z:
    /// <c>cell(x,y,z) = Cells[x + y*DimX + z*DimX*DimY]</c>. 0 = empty.
    /// </summary>
    public required byte[] Cells { get; init; }
}

public readonly record struct PvxPaletteEntry(byte R, byte G, byte B, byte A, byte MaterialId);

public readonly record struct PvxMaterial(float Density, float CompressiveStrength, float TensileStrength);

/// <summary>
/// The .pvx binary format, v1 (little-endian). The layout is a wire contract shared with
/// the client decoder at <c>wwwroot/js/povoxelstrike/pvx.js</c> — change both together:
///
///   magic 'PVX1' (4B) | version u16 | dimX u16 | dimY u16 | dimZ u16 | flags u16
///   paletteCount u16  | per entry: R u8, G u8, B u8, A u8, materialId u8
///   materialCount u8  | per entry: density f32, compressiveStr f32, tensileStr f32
///   payloadLength u32 | RLE runs of (count u16, paletteIndex u8), X→Y→Z cell order
/// </summary>
public static class PvxSerializer
{
    public const ushort Version = 1;
    private static ReadOnlySpan<byte> Magic => "PVX1"u8;

    public static void Write(PvxVolume volume, Stream output)
    {
        using var writer = new BinaryWriter(output, System.Text.Encoding.UTF8, leaveOpen: true);
        writer.Write(Magic);
        writer.Write(Version);
        writer.Write(checked((ushort)volume.DimX));
        writer.Write(checked((ushort)volume.DimY));
        writer.Write(checked((ushort)volume.DimZ));
        writer.Write((ushort)0); // flags

        writer.Write(checked((ushort)volume.Palette.Count));
        foreach (var p in volume.Palette)
        {
            writer.Write(p.R); writer.Write(p.G); writer.Write(p.B); writer.Write(p.A);
            writer.Write(p.MaterialId);
        }

        writer.Write(checked((byte)volume.Materials.Count));
        foreach (var m in volume.Materials)
        {
            writer.Write(m.Density);
            writer.Write(m.CompressiveStrength);
            writer.Write(m.TensileStrength);
        }

        var rle = Encode(volume.Cells);
        writer.Write(checked((uint)rle.Length));
        writer.Write(rle);
    }

    /// <summary>Dims-only header read, used to index pre-existing .pvx files whose sidecar is missing.</summary>
    public static (int DimX, int DimY, int DimZ) ReadDimensions(Stream input)
    {
        Span<byte> header = stackalloc byte[12];
        input.ReadExactly(header);
        if (!header[..4].SequenceEqual(Magic))
        {
            throw new InvalidDataException("Not a PVX1 file.");
        }
        return (BinaryPrimitives.ReadUInt16LittleEndian(header[6..]),
                BinaryPrimitives.ReadUInt16LittleEndian(header[8..]),
                BinaryPrimitives.ReadUInt16LittleEndian(header[10..]));
    }

    private static byte[] Encode(ReadOnlySpan<byte> cells)
    {
        using var ms = new MemoryStream();
        Span<byte> run = stackalloc byte[3];
        var i = 0;
        while (i < cells.Length)
        {
            var value = cells[i];
            var count = 1;
            while (i + count < cells.Length && cells[i + count] == value && count < ushort.MaxValue)
            {
                count++;
            }
            BinaryPrimitives.WriteUInt16LittleEndian(run, (ushort)count);
            run[2] = value;
            ms.Write(run);
            i += count;
        }
        return ms.ToArray();
    }
}
