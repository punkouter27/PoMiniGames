using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>One converted asset the API can serve. Identity is the SHA-256 of the source GLB bytes.</summary>
public sealed record VoxelAssetInfo(
    string Hash,
    string Name,
    int DimX,
    int DimY,
    int DimZ,
    long SizeBytes,
    string PayloadPath,
    /// <summary>Material entries the M2 stress solver uses (density, compressive, tensile).
    /// Empty when no sidecar was provided at ingest time — the voxelizer falls back to
    /// the "concrete-ish" default and the client infers the same default from an
    /// empty table.</summary>
    IReadOnlyList<VoxelAssetMaterial> Materials = null!,
    /// <summary>Optional display names keyed by material id (the sidecar's <c>DisplayName</c>).
    /// Empty when no sidecar was provided.</summary>
    IReadOnlyDictionary<byte, string> MaterialNames = null!);

/// <summary>One material entry surfaced in the manifest. MaterialId is 1-based (0 = unused).</summary>
public sealed record VoxelAssetMaterial(byte MaterialId, string DisplayName, float Density, float CompressiveStrength, float TensileStrength);

/// <summary>
/// In-memory index of converted voxel assets. Filled by <see cref="AssetIngestionHostedService"/>
/// (pre-existing .pvx files first, then fresh conversions as each completes) and read by the
/// manifest/payload endpoints — so requests never touch the filesystem for discovery, and a
/// client polling while ingestion is still running simply sees the catalog grow.
/// </summary>
public sealed class VoxelAssetCatalog
{
    private readonly ConcurrentDictionary<string, VoxelAssetInfo> _assets = new(StringComparer.Ordinal);

    public void Add(VoxelAssetInfo asset) => _assets[asset.Hash] = asset;

    public bool TryGet(string hash, out VoxelAssetInfo asset)
    {
        var found = _assets.TryGetValue(hash, out var value);
        asset = value!;
        return found;
    }

    public IReadOnlyList<VoxelAssetInfo> All =>
        _assets.Values.OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase).ToList();
}
