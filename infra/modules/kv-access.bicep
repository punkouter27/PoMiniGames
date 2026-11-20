param keyVaultName string
param principalId string

resource keyVault 'Microsoft.KeyVault/vaults@2023-02-01' existing = {
  name: keyVaultName
}

// Grant the Web App's system-assigned MI secrets get+list on the shared vault.
// We use a vault access policy rather than a control-plane RBAC role because
// `kv-poshared2` is deployed with `enableRbacAuthorization: false` (legacy mode).
// The access policy covers both `getSecret` (used by the runtime config provider
// for `PoMiniGames--*` keys) and `list` (required by
// `AzureKeyVaultConfigurationProvider.Load()` which enumerates the secrets
// prefix via `GetPropertiesOfSecrets`).
resource kvSecretsAccessPolicy 'Microsoft.KeyVault/vaults/accessPolicies@2023-02-01' = {
  parent: keyVault
  // `name` must be the literal operation identifier ('add'|'remove'|'replace')
  // per Microsoft.KeyVault/vaults/accessPolicies@2023-02-01. Interpolated
  // names trigger BCP036. The `uniqueString` previously used here added no
  // value — duplicate `add` operations on the same vault are merged by ARM.
  name: 'add'
  properties: {
    accessPolicies: [
      {
        objectId: principalId
        tenantId: subscription().tenantId
        permissions: {
          secrets: [
            'get'
            'list'
          ]
        }
      }
    ]
  }
}
