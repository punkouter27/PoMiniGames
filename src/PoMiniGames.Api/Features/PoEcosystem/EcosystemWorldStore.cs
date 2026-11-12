using System.Security.Cryptography;
using System.Text;
using Azure;
using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using PoMiniGames.Shared.Games.PoEcosystem;

namespace PoMiniGames.Features.PoEcosystem;

/// <summary>
/// Cloud storage for PoEcosystem worlds: the snapshot bytes in a blob container, the
/// slot metadata (and the public gallery index) in one table.
/// </summary>
/// <remarks>
/// <para>
/// A snapshot is opaque here — gzip'd JSON the browser engine wrote (js/poecosystem/sim/
/// persistence/codec.js) and only the browser engine can read. It is a blob rather than a
/// table property because a hundred-year world is a megabyte compressed and Table Storage
/// caps a property at 64 KiB and an entity at 1 MiB.
/// </para>
/// <para>
/// Layout. Table <c>PoEcosystemWorlds</c>: PartitionKey = a hash of the owner's claim id,
/// RowKey = the slot ("1"–"3"). Sharing writes a mirror row into the <c>public</c>
/// partition keyed by the share code, so the gallery is one partition query rather than a
/// table scan, and the code never reveals whose partition it points at. Blob
/// <c>poecosystem-worlds/{ownerHash}/{slot}.json.gz</c>.
/// </para>
/// <para>
/// Every method degrades rather than throws: an unreachable account (Azurite down) returns
/// empty/null and the dashboard says so. The island itself keeps running whatever the
/// storage does — the local IndexedDB save is still the primary copy.
/// </para>
/// </remarks>
public sealed class EcosystemWorldStore
{
    public const string TableName = "PoEcosystemWorlds";
    public const string ContainerName = "poecosystem-worlds";
    private const string PublicPartition = "public";
    private const int GalleryCap = 50;

    private readonly TableClient _table;
    private readonly BlobContainerClient _container;
    private readonly ILogger<EcosystemWorldStore> _logger;
    private bool _ensured;

    public EcosystemWorldStore(TableServiceClient tables, BlobServiceClient blobs, ILogger<EcosystemWorldStore> logger)
    {
        _table = tables.GetTableClient(TableName);
        _container = blobs.GetBlobContainerClient(ContainerName);
        _logger = logger;
    }

    /// <summary>The partition an identity's slots live in. Hashed so a share code or a blob path never carries a raw claim id.</summary>
    public static string OwnerKey(string userId)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(userId)))[..24].ToLowerInvariant();

    private async Task EnsureAsync(CancellationToken ct)
    {
        if (_ensured) return;
        await _table.CreateIfNotExistsAsync(ct);
        await _container.CreateIfNotExistsAsync(cancellationToken: ct);
        _ensured = true;
    }

    public async Task<EcoWorldMeta[]> ListAsync(string userId, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var owner = OwnerKey(userId);
            var rows = new List<EcoWorldMeta>();
            await foreach (var e in _table.QueryAsync<TableEntity>(x => x.PartitionKey == owner, cancellationToken: ct))
                rows.Add(ToMeta(e));
            return rows.OrderBy(r => r.Slot, StringComparer.Ordinal).ToArray();
        }
        catch (Exception ex)
        {
            _logger.EcoStoreFailed(ex, "list");
            return [];
        }
    }

    public async Task<EcoWorldMeta?> SaveAsync(
        string userId, string ownerName, string slot, string name, int seed, int year, int tick, int[] counts, byte[] bytes,
        CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var owner = OwnerKey(userId);
            var blob = _container.GetBlobClient(BlobName(owner, slot));
            await blob.UploadAsync(
                BinaryData.FromBytes(bytes),
                new BlobUploadOptions { HttpHeaders = new BlobHttpHeaders { ContentType = "application/gzip" } },
                ct);

            // A slot that is already shared keeps its code: re-saving updates the island
            // behind the same gallery entry rather than minting a new one.
            string shareCode = "";
            try
            {
                var existing = await _table.GetEntityAsync<TableEntity>(owner, slot, cancellationToken: ct);
                shareCode = existing.Value.GetString("ShareCode") ?? "";
            }
            catch (RequestFailedException ex) when (ex.Status == 404) { }

            var entity = new TableEntity(owner, slot)
            {
                ["Name"] = name,
                ["Seed"] = seed,
                ["Year"] = year,
                ["Tick"] = tick,
                ["Counts"] = string.Join(',', counts),
                ["SavedAt"] = DateTimeOffset.UtcNow,
                ["SizeBytes"] = (long)bytes.Length,
                ["ShareCode"] = shareCode,
                ["OwnerName"] = ownerName,
                ["SchemaVersion"] = 2,
            };
            await _table.UpsertEntityAsync(entity, TableUpdateMode.Replace, ct);
            if (shareCode.Length > 0) await _table.UpsertEntityAsync(Mirror(shareCode, owner, entity), TableUpdateMode.Replace, ct);
            return ToMeta(entity);
        }
        catch (Exception ex)
        {
            _logger.EcoStoreFailed(ex, "save");
            return null;
        }
    }

    public Task<byte[]?> LoadAsync(string userId, string slot, CancellationToken ct = default)
        => DownloadAsync(OwnerKey(userId), slot, ct);

    public async Task<bool> DeleteAsync(string userId, string slot, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var owner = OwnerKey(userId);
            try
            {
                var existing = await _table.GetEntityAsync<TableEntity>(owner, slot, cancellationToken: ct);
                var code = existing.Value.GetString("ShareCode");
                if (!string.IsNullOrEmpty(code)) await _table.DeleteEntityAsync(PublicPartition, code, cancellationToken: ct);
            }
            catch (RequestFailedException ex) when (ex.Status == 404) { }
            await _table.DeleteEntityAsync(owner, slot, cancellationToken: ct);
            await _container.GetBlobClient(BlobName(owner, slot)).DeleteIfExistsAsync(cancellationToken: ct);
            return true;
        }
        catch (Exception ex)
        {
            _logger.EcoStoreFailed(ex, "delete");
            return false;
        }
    }

    public async Task<EcoWorldMeta?> ShareAsync(string userId, string slot, bool isPublic, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var owner = OwnerKey(userId);
            var response = await _table.GetEntityAsync<TableEntity>(owner, slot, cancellationToken: ct);
            var entity = response.Value;
            var code = entity.GetString("ShareCode") ?? "";
            if (isPublic)
            {
                if (code.Length == 0) code = NewShareCode();
                entity["ShareCode"] = code;
                await _table.UpsertEntityAsync(Mirror(code, owner, entity), TableUpdateMode.Replace, ct);
            }
            else if (code.Length > 0)
            {
                await _table.DeleteEntityAsync(PublicPartition, code, cancellationToken: ct);
                entity["ShareCode"] = "";
            }
            await _table.UpsertEntityAsync(entity, TableUpdateMode.Replace, ct);
            return ToMeta(entity);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
        catch (Exception ex)
        {
            _logger.EcoStoreFailed(ex, "share");
            return null;
        }
    }

    public async Task<EcoSharedWorld[]> GalleryAsync(int top, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var rows = new List<EcoSharedWorld>();
            await foreach (var e in _table.QueryAsync<TableEntity>(x => x.PartitionKey == PublicPartition, maxPerPage: GalleryCap, cancellationToken: ct))
            {
                rows.Add(new EcoSharedWorld(
                    e.RowKey,
                    e.GetString("Name") ?? "An island",
                    e.GetString("OwnerName") ?? "Someone",
                    e.GetInt32("Seed") ?? 0,
                    e.GetInt32("Year") ?? 0,
                    ParseCounts(e.GetString("Counts")),
                    e.GetDateTimeOffset("SavedAt") ?? DateTimeOffset.MinValue,
                    e.GetInt64("SizeBytes") ?? 0));
                if (rows.Count >= GalleryCap) break;
            }
            return rows.OrderByDescending(r => r.SavedAt).Take(Math.Clamp(top, 1, GalleryCap)).ToArray();
        }
        catch (Exception ex)
        {
            _logger.EcoStoreFailed(ex, "gallery");
            return [];
        }
    }

    public async Task<byte[]?> LoadSharedAsync(string code, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var mirror = await _table.GetEntityAsync<TableEntity>(PublicPartition, code, cancellationToken: ct);
            var owner = mirror.Value.GetString("OwnerKey");
            var slot = mirror.Value.GetString("Slot");
            if (string.IsNullOrEmpty(owner) || string.IsNullOrEmpty(slot)) return null;
            return await DownloadAsync(owner, slot, ct);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
        catch (Exception ex)
        {
            _logger.EcoStoreFailed(ex, "load-shared");
            return null;
        }
    }

    private async Task<byte[]?> DownloadAsync(string owner, string slot, CancellationToken ct)
    {
        try
        {
            await EnsureAsync(ct);
            var blob = _container.GetBlobClient(BlobName(owner, slot));
            if (!await blob.ExistsAsync(ct)) return null;
            var content = await blob.DownloadContentAsync(ct);
            return content.Value.Content.ToArray();
        }
        catch (Exception ex)
        {
            _logger.EcoStoreFailed(ex, "load");
            return null;
        }
    }

    private static string BlobName(string owner, string slot) => $"{owner}/{slot}.json.gz";

    private static TableEntity Mirror(string code, string owner, TableEntity source) => new(PublicPartition, code)
    {
        ["OwnerKey"] = owner,
        ["Slot"] = source.RowKey,
        ["Name"] = source.GetString("Name") ?? "",
        ["OwnerName"] = source.GetString("OwnerName") ?? "",
        ["Seed"] = source.GetInt32("Seed") ?? 0,
        ["Year"] = source.GetInt32("Year") ?? 0,
        ["Counts"] = source.GetString("Counts") ?? "",
        ["SavedAt"] = source.GetDateTimeOffset("SavedAt") ?? DateTimeOffset.UtcNow,
        ["SizeBytes"] = source.GetInt64("SizeBytes") ?? 0L,
        ["SchemaVersion"] = source.GetInt32("SchemaVersion") ?? 2,
    };

    private static EcoWorldMeta ToMeta(TableEntity e) => new(
        e.RowKey,
        e.GetString("Name") ?? "",
        e.GetInt32("Seed") ?? 0,
        e.GetInt32("Year") ?? 0,
        e.GetInt32("Tick") ?? 0,
        ParseCounts(e.GetString("Counts")),
        e.GetDateTimeOffset("SavedAt") ?? DateTimeOffset.MinValue,
        e.GetInt64("SizeBytes") ?? 0,
        string.IsNullOrEmpty(e.GetString("ShareCode")) ? null : e.GetString("ShareCode"),
        e.GetString("OwnerName"));

    /// <summary>Four comma-separated counts; anything else reads as an empty island rather than throwing.</summary>
    internal static int[] ParseCounts(string? csv)
    {
        var parts = (csv ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries);
        var out4 = new int[4];
        for (var i = 0; i < Math.Min(4, parts.Length); i++) out4[i] = int.TryParse(parts[i], out var v) ? Math.Max(0, v) : 0;
        return out4;
    }

    // Eight characters from an alphabet without look-alikes: read aloud, typed, never guessed
    // in useful time (32^8 ≈ 10^12) — and a code only ever opens a world its owner chose to share.
    private const string CodeAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    private static string NewShareCode()
        => string.Create(8, 0, static (span, _) => { for (var i = 0; i < span.Length; i++) span[i] = CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)]; });
}
