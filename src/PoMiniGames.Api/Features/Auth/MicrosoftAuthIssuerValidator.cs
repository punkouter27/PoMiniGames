using System.IdentityModel.Tokens.Jwt;
using Microsoft.IdentityModel.Tokens;

namespace PoMiniGames.Features.Auth;

/// <summary>
/// Allow-list validator for Microsoft Entra ID token issuers.
///
/// <para>
/// Public, multi-tenant apps that accept sign-ins from arbitrary Microsoft Entra tenants
/// (work / school) and personal Microsoft accounts must validate the <c>iss</c> claim against
/// a known-safe set, otherwise an attacker can mint tokens from a hostile tenant and have
/// them accepted by the API. This class pins the set of acceptable issuer URIs.
/// </para>
///
/// <remarks>
/// Pattern: Specification (Erich Gamma et al., 1994). The "spec" is the Microsoft identity
/// platform metadata document: <c>https://login.microsoftonline.com/{tenant}/v2.0</c>. This
/// validator is a pure function that maps the abstract rule "issuer must be one of
/// {common, organizations, consumers, or an explicit tenant ID}" onto a concrete
/// <see cref="string"/> comparison. The set is closed under future tenant additions via
/// the <c>AllowedTenantIds</c> option.
///
/// <para>References:</para>
/// <list type="bullet">
///   <item>https://learn.microsoft.com/azure/active-directory/develop/v2-protocols-oidc#find-your-apps-endpoint-tenant</item>
///   <item>https://learn.microsoft.com/entra/identity-platform/id-tokens#payload-claims</item>
/// </list>
/// </remarks>
public static class MicrosoftAuthIssuerValidator
{
    /// <summary>Well-known personal-account (MSA) tenant — "consumers" v2.0.</summary>
    public const string ConsumersTenantId = "9188040d-6c67-4c5b-b112-36a304b66dad";

    private const string AuthorityBase = "https://login.microsoftonline.com";

    private static readonly HashSet<string> PublicTenantIds = new(StringComparer.OrdinalIgnoreCase)
    {
        // multi-tenant / work-school
        "common",
        "organizations",
        // personal Microsoft accounts
        "consumers",
        ConsumersTenantId,
    };

    /// <summary>
    /// Returns the issuer string when the supplied <paramref name="issuer"/> matches an
    /// allowed public authority or a tenant ID explicitly listed in
    /// <paramref name="allowedTenantIds"/>; throws <see cref="SecurityTokenInvalidIssuerException"/>
    /// otherwise.
    /// </summary>
    /// <remarks>
    /// The returned <see cref="string"/> is the canonical v2.0 issuer URI for the matched
    /// authority, which is what the rest of the JWT pipeline expects to see via
    /// <c>ValidIssuer</c>.
    /// </remarks>
    public static string Validate(string? issuer, IReadOnlyCollection<string> allowedTenantIds)
    {
        if (string.IsNullOrWhiteSpace(issuer))
        {
            throw new SecurityTokenInvalidIssuerException("Token issuer is empty.");
        }

        // Allow any tenant ID that has been explicitly approved for this API.
        foreach (var tenantId in allowedTenantIds)
        {
            if (string.IsNullOrWhiteSpace(tenantId))
            {
                continue;
            }

            if (issuer.Equals($"{AuthorityBase}/{tenantId}/v2.0", StringComparison.OrdinalIgnoreCase)
                || issuer.Equals($"{AuthorityBase}/{tenantId}", StringComparison.OrdinalIgnoreCase))
            {
                return issuer;
            }
        }

        // Public multi-tenant authorities.
        foreach (var publicId in PublicTenantIds)
        {
            if (issuer.Equals($"{AuthorityBase}/{publicId}/v2.0", StringComparison.OrdinalIgnoreCase))
            {
                return issuer;
            }
        }

        throw new SecurityTokenInvalidIssuerException(
            $"Token issuer '{issuer}' is not in the allowed tenant list.");
    }
}
