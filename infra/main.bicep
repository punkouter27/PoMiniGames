// PoMiniGames infrastructure. Run locally (never from CI), from the repo root:
//   az deployment sub what-if -l westus2 -f infra/main.bicep -p infra/main.bicepparam
//   az deployment sub create  -l westus2 -f infra/main.bicep -p infra/main.bicepparam
// Names follow the Po web standard (AGENTS.md): App Service app-pominigames. The plan and the storage account keep
// their original names (asp-pominigames-f1, st5ln5hfdrvof5u2) because renaming them means re-creating them.
targetScope = 'subscription'

@description('Azure region for the resource group and its resources')
param location string

@description('The name of the resource group to create')
param resourceGroupName string = 'PoMiniGames'

@description('The name of the existing shared resource group')
param sharedResourceGroupName string = 'PoShared'

@description('Existing shared Key Vault name')
param sharedKeyVaultName string = 'kv-poshared2'

@description('App Service name (Po web standard: app-<repo lowercase>)')
param webAppName string = 'app-pominigames'

@description('Existing App Service plan (F1, Windows) in the resource group')
param appServicePlanName string = 'asp-pominigames-f1'

@description('Existing storage account (Tables + Blobs) in the resource group')
param storageAccountName string = 'st5ln5hfdrvof5u2'

var tags = {
  app: 'PoMiniGames'
}

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources './modules/resources.bicep' = {
  name: 'resources'
  scope: rg
  params: {
    location: location
    tags: tags
    webAppName: webAppName
    appServicePlanName: appServicePlanName
    storageAccountName: storageAccountName
    sharedResourceGroupName: sharedResourceGroupName
    sharedKeyVaultName: sharedKeyVaultName
  }
}

module kvAccess './modules/kv-access.bicep' = {
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
module kvSecrets './modules/kv-secrets.bicep' = {
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
