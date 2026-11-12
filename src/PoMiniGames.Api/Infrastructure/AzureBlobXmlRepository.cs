using System.Collections.Concurrent;
using System.Xml.Linq;
using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Microsoft.AspNetCore.DataProtection.Repositories;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Stores ASP.NET Core Data Protection key rings in an Azure Blob container as XML documents.
/// </summary>
/// <remarks>
/// <para>
/// The <c>Microsoft.AspNetCore.DataProtection.AzureStorage</c> 1.0.x package pulls
/// transitive .NET Framework-only packages (Microsoft.Data.Edm, Microsoft.Data.OData,
/// System.Spatial) which is incompatible with the .NET 10 build under
/// <c>TreatWarningsAsErrors=true</c>. This implementation uses the modern
/// <c>Azure.Storage.Blobs</c> SDK (already in the dependency graph) directly, sidestepping
/// the legacy OData surface.
/// </para>
/// <para>
/// Container layout: one blob per key element, named <c>key-{guid}.xml</c>. The
/// container is created lazily on first write. Reads enumerate all blobs and concatenate
/// the XML documents; the framework handles deduplication by element id.
/// </para>
/// <para>
/// Pattern: Repository (Gamma et al., 1994) + Adapter. The framework speaks
/// <see cref="IXmlRepository"/>; the underlying store is blob storage. The adapter
/// translates between the two contracts and absorbs the missing-credential / network-blip
/// surface area into a single try/catch.
/// </para>
/// </remarks>
public sealed class AzureBlobXmlRepository : IXmlRepository
{
    private const string KeyBlobPrefix = "key-";
    private const string KeyBlobSuffix = ".xml";

    private readonly BlobContainerClient _container;
    private readonly ILogger<AzureBlobXmlRepository> _logger;

    public AzureBlobXmlRepository(BlobContainerClient container, ILogger<AzureBlobXmlRepository> logger)
    {
        _container = container;
        _logger = logger;
    }

    public IReadOnlyCollection<XElement> GetAllElements()
    {
        var results = new List<XElement>();
        try
        {
            foreach (var blob in _container.GetBlobs(BlobTraits.None, BlobStates.None, KeyBlobPrefix, CancellationToken.None))
            {
                if (!blob.Name.EndsWith(KeyBlobSuffix, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var client = _container.GetBlobClient(blob.Name);
                try
                {
                    var xml = client.DownloadContent().Value.Content.ToString();
                    if (string.IsNullOrWhiteSpace(xml))
                    {
                        continue;
                    }

                    results.Add(XElement.Parse(xml));
                }
                catch (RequestFailedException ex) when (ex.Status == 404)
                {
                    // Key blob was deleted between enumeration and download; skip.
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "Failed to read data-protection key blob {BlobName}", blob.Name);
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Failed to enumerate data-protection key blobs in {Container}", _container.Name);
        }

        return results;
    }

    public void StoreElement(XElement element, string friendlyName)
    {
        var blobName = $"{KeyBlobPrefix}{Guid.NewGuid():N}{KeyBlobSuffix}";
        var client = _container.GetBlobClient(blobName);

        try
        {
            _container.CreateIfNotExists();
            using var stream = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(element.ToString()));
            client.Upload(stream, new BlobUploadOptions
            {
                HttpHeaders = new BlobHttpHeaders { ContentType = "application/xml" },
            });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Failed to write data-protection key {FriendlyName} to {Container}", friendlyName, _container.Name);
            throw;
        }
    }
}
