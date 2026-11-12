using System.Buffers.Binary;
using System.IO.Compression;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Minimal PNG reader, just enough to sample a glTF base-color texture.
///
/// Deliberately hand-rolled rather than taking an imaging package: the voxelizer needs
/// exactly one operation — "give me RGBA8 for this buffer" — and the build gates on a
/// NuGet CVE audit, so an image library with a long advisory history is a poor trade for
/// ~150 lines of very well-specified format. Inflate comes from the BCL
/// (<see cref="ZLibStream"/>); everything else here is scanline un-filtering, which is
/// the whole of PNG once the bytes are decompressed.
///
/// Supported: bit depths 1/2/4/8/16, colour types 0 (grey), 2 (RGB), 3 (palette),
/// 4 (grey+alpha), 6 (RGBA), with tRNS. NOT supported: Adam7 interlacing, which no
/// exporter produces for model textures. Anything unsupported returns null, and the
/// caller falls back to the material's flat base-color factor exactly as before.
/// </summary>
internal static class PngDecoder
{
    private static ReadOnlySpan<byte> Signature => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    internal sealed record Image(int Width, int Height, byte[] Rgba);

    public static Image? TryDecode(ReadOnlySpan<byte> data)
    {
        if (data.Length < 8 || !data[..8].SequenceEqual(Signature))
        {
            return null;
        }

        int width = 0, height = 0, bitDepth = 0, colorType = 0;
        byte[]? palette = null;
        byte[]? paletteAlpha = null;
        using var idat = new MemoryStream();

        var offset = 8;
        while (offset + 8 <= data.Length)
        {
            var length = BinaryPrimitives.ReadInt32BigEndian(data[offset..]);
            if (length < 0 || offset + 12 + length > data.Length)
            {
                return null;
            }
            var type = data.Slice(offset + 4, 4);
            var chunk = data.Slice(offset + 8, length);
            offset += 12 + length; // length + type + data + crc

            if (type.SequenceEqual("IHDR"u8))
            {
                if (length < 13) return null;
                width = BinaryPrimitives.ReadInt32BigEndian(chunk);
                height = BinaryPrimitives.ReadInt32BigEndian(chunk[4..]);
                bitDepth = chunk[8];
                colorType = chunk[9];
                if (chunk[10] != 0 || chunk[11] != 0 || chunk[12] != 0)
                {
                    return null; // unknown compression/filter, or Adam7 interlace
                }
                if (width <= 0 || height <= 0 || (long)width * height > 64_000_000L)
                {
                    return null;
                }
            }
            else if (type.SequenceEqual("PLTE"u8))
            {
                palette = chunk.ToArray();
            }
            else if (type.SequenceEqual("tRNS"u8))
            {
                paletteAlpha = chunk.ToArray();
            }
            else if (type.SequenceEqual("IDAT"u8))
            {
                idat.Write(chunk);
            }
            else if (type.SequenceEqual("IEND"u8))
            {
                break;
            }
        }

        if (width == 0 || idat.Length == 0)
        {
            return null;
        }

        var channels = colorType switch
        {
            0 => 1,
            2 => 3,
            3 => 1,
            4 => 2,
            6 => 4,
            _ => 0,
        };
        if (channels == 0)
        {
            return null;
        }
        if (colorType != 3 && bitDepth != 8 && bitDepth != 16)
        {
            return null; // sub-byte depths are only defined for grey/palette; skip grey
        }
        if (colorType == 3 && palette is null)
        {
            return null;
        }

        var raw = Inflate(idat);
        if (raw is null)
        {
            return null;
        }

        // Scanline layout: one filter byte, then the row. `bpp` is the filter's notion of
        // "previous pixel" distance and is at least 1 byte even for sub-byte depths.
        var bitsPerPixel = channels * bitDepth;
        var stride = (width * bitsPerPixel + 7) / 8;
        var bpp = Math.Max(1, bitsPerPixel / 8);
        if ((long)(stride + 1) * height > raw.Length)
        {
            return null;
        }

        var lines = new byte[height * stride];
        var prev = new byte[stride];
        var pos = 0;
        for (var y = 0; y < height; y++)
        {
            var filter = raw[pos++];
            var row = lines.AsSpan(y * stride, stride);
            raw.AsSpan(pos, stride).CopyTo(row);
            pos += stride;
            Unfilter(filter, row, prev, bpp);
            row.CopyTo(prev);
        }

        return new Image(width, height, ToRgba(lines, width, height, stride, bitDepth, colorType, palette, paletteAlpha));
    }

    private static byte[]? Inflate(MemoryStream idat)
    {
        try
        {
            idat.Position = 0;
            using var z = new ZLibStream(idat, CompressionMode.Decompress, leaveOpen: true);
            using var outp = new MemoryStream();
            z.CopyTo(outp);
            return outp.ToArray();
        }
        catch (InvalidDataException)
        {
            return null;
        }
    }

    private static void Unfilter(byte filter, Span<byte> row, ReadOnlySpan<byte> prev, int bpp)
    {
        switch (filter)
        {
            case 0:
                break;
            case 1: // Sub
                for (var i = bpp; i < row.Length; i++) row[i] = (byte)(row[i] + row[i - bpp]);
                break;
            case 2: // Up
                for (var i = 0; i < row.Length; i++) row[i] = (byte)(row[i] + prev[i]);
                break;
            case 3: // Average
                for (var i = 0; i < row.Length; i++)
                {
                    var left = i >= bpp ? row[i - bpp] : 0;
                    row[i] = (byte)(row[i] + ((left + prev[i]) >> 1));
                }
                break;
            case 4: // Paeth
                for (var i = 0; i < row.Length; i++)
                {
                    int a = i >= bpp ? row[i - bpp] : 0;
                    int b = prev[i];
                    int c = i >= bpp ? prev[i - bpp] : 0;
                    var p = a + b - c;
                    var pa = Math.Abs(p - a);
                    var pb = Math.Abs(p - b);
                    var pc = Math.Abs(p - c);
                    var pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                    row[i] = (byte)(row[i] + pred);
                }
                break;
            default:
                break; // unknown filter: leave the row as-is rather than throw
        }
    }

    private static byte[] ToRgba(byte[] lines, int width, int height, int stride, int bitDepth,
        int colorType, byte[]? palette, byte[]? paletteAlpha)
    {
        var rgba = new byte[width * height * 4];
        var step = bitDepth == 16 ? 2 : 1;   // 16-bit samples are truncated to their high byte

        for (var y = 0; y < height; y++)
        {
            var row = lines.AsSpan(y * stride, stride);
            for (var x = 0; x < width; x++)
            {
                var o = (y * width + x) * 4;
                byte r, g, b, a = 255;

                if (colorType == 3)
                {
                    var index = ReadIndex(row, x, bitDepth);
                    var p = index * 3;
                    if (palette is null || p + 2 >= palette.Length) { r = g = b = 0; }
                    else { r = palette[p]; g = palette[p + 1]; b = palette[p + 2]; }
                    if (paletteAlpha is not null && index < paletteAlpha.Length) a = paletteAlpha[index];
                }
                else
                {
                    var channels = colorType switch { 0 => 1, 2 => 3, 4 => 2, _ => 4 };
                    var i = x * channels * step;
                    if (i + (channels - 1) * step >= row.Length) { r = g = b = 0; }
                    else if (colorType == 0) { r = g = b = row[i]; }
                    else if (colorType == 4) { r = g = b = row[i]; a = row[i + step]; }
                    else if (colorType == 2) { r = row[i]; g = row[i + step]; b = row[i + 2 * step]; }
                    else { r = row[i]; g = row[i + step]; b = row[i + 2 * step]; a = row[i + 3 * step]; }
                }

                rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
            }
        }
        return rgba;
    }

    /// <summary>Palette index at pixel x, for bit depths 1/2/4/8 packed big-endian in the row.</summary>
    private static int ReadIndex(ReadOnlySpan<byte> row, int x, int bitDepth)
    {
        if (bitDepth == 8)
        {
            return x < row.Length ? row[x] : 0;
        }
        var perByte = 8 / bitDepth;
        var byteIndex = x / perByte;
        if (byteIndex >= row.Length)
        {
            return 0;
        }
        var shift = 8 - bitDepth * (x % perByte + 1);
        return (row[byteIndex] >> shift) & ((1 << bitDepth) - 1);
    }
}
