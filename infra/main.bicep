targetScope = 'subscription'

param name string
param location string

@description('The name of the resource group to create')
param resourceGroupName string = 'PoMiniGames'

@description('The name of the existing shared resource group')
param sharedResourceGroupName string = 'PoShared'

@description('Existing shared Key Vault name')
param sharedKeyVaultName string = 'kv-poshared2'

// ── Microsoft (Entra ID) OAuth configuration ─────────────────────────────
// Wire the SPA client ID + API audience as Bicep parameters so the App Service
// App Settings surface the real production values. Microsoft "client IDs" are
// public identifiers (not secrets) — they belong in App Settings, not in
// Key Vault. Override per environment via main.parameters.json or
// `azd env set PoMiniGamesMicrosoftAuthClientId <APP_ID>`.
//
// Defaults are empty: a deploy that ships with no ClientId will be caught
// by StartupSecretValidator (fail-fast: throws InvalidOperationException).
@description('Entra ID SPA app registration client ID (PoMiniGames__MicrosoftAuth__ClientId)')
param microsoftAuthClientId string = ''

@description('Entra ID API audience / scope (PoMiniGames__MicrosoftAuth__ApiClientId)')
param microsoftAuthApiClientId string = ''

@description('Entra ID tenant id used to compose the authority URL (defaults to the deploying tenant)')
param microsoftAuthTenantId string = tenant().tenantId

var tags = {
  'azd-env-name': name
}

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources './resources.bicep' = {
  name: 'resources'
  scope: rg
  params: {
    name: name
    location: location
    tags: tags
    sharedResourceGroupName: sharedResourceGroupName
    sharedKeyVaultName: sharedKeyVaultName
    microsoftAuthClientId: microsoftAuthClientId
    microsoftAuthApiClientId: microsoftAuthApiClientId
    microsoftAuthTenantId: microsoftAuthTenantId
  }
}

module kvAccess './kv-access.bicep' = {
  name: 'kv-access'
  scope: resourceGroup(sharedResourceGroupName)
  params: {
    keyVaultName: sharedKeyVaultName
    principalId: resources.outputs.WEB_APP_PRINCIPAL_ID
  }
}

// Mirror the storage account name into Key Vault so
// the app reads them via the centralized PrefixKeyVaultSecretManager at
// startup, and so secrets-rotation scripts have a single source of truth.
module kvSecrets './kv-secrets.bicep' = {
  name: 'kv-secrets'
  scope: resourceGroup(sharedResourceGroupName)
  params: {
    keyVaultName: sharedKeyVaultName
    storageAccountName: resources.outputs.STORAGE_ACCOUNT_NAME
  }
}

output API_URI string = resources.outputs.API_URI
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output WEB_APP_NAME string = resources.outputs.WEB_APP_NAME

output AZURE_RESOURCE_GROUP string = rg.name
