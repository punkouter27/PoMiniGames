param location string
param tags object

@description('App Service name (Po web standard: app-<repo lowercase>)')
param webAppName string

@description('App Service plan name (F1, Windows)')
param appServicePlanName string

@description('Storage account name (Tables + Blobs)')
param storageAccountName string

@description('The name of the existing Key Vault in PoShared')
param sharedKeyVaultName string = 'kv-poshared2'

@description('The name of the existing App Insights in PoShared')
param sharedAppInsightsName string = 'poappideinsights8f9c9a4e'

@description('The name of the resource group containing shared resources')
param sharedResourceGroupName string = 'PoShared'

var planName = appServicePlanName
var storageTableDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
// Storage Blob Data Contributor covers both the table writes (it includes table perms) and
// the blob container CreateIfNotExists that DataProtection uses for key escrow.
var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

// Zero-waste compute: a single dedicated F1 (Free) Windows plan for this app.
// F1 is the lowest tier (no idle cost); SKU/OS are expressed as tags, never
// baked into the resource name (CAF best practice — names stay stable across
// tier changes). F1 cannot enable alwaysOn, so cold-starts are expected.
resource appServicePlan 'Microsoft.Web/serverfarms@2022-09-01' = {
  name: planName
  location: location
  tags: union(tags, { tier: 'F1', os: 'windows' })
  kind: 'app'
  sku: {
    name: 'F1'
    tier: 'Free'
    capacity: 1
  }
  properties: {
    reserved: false // Windows
  }
}

// Web App — Windows .NET 10, single-origin host (Blazor WASM served from
// wwwroot; no CORS). Forced PROD profile via ASPNETCORE_ENVIRONMENT.
resource webApp 'Microsoft.Web/sites@2022-09-01' = {
  name: webAppName
  location: location
  tags: union(tags, { tier: 'F1', os: 'windows' })
  kind: 'app'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      netFrameworkVersion: 'v10.0'
      alwaysOn: false // F1 does not support alwaysOn
      webSocketsEnabled: true // SignalR multiplayer hubs (F1 allows a few concurrent sockets; others fall back)
      http20Enabled: true
      ftpsState: 'FtpsOnly'
      minTlsVersion: '1.2'
      metadata: [
        {
          name: 'CURRENT_STACK'
          value: 'dotnet'
        }
      ]
      appSettings: [
        // WEBSITE_RUN_FROM_PACKAGE = 1 → atomic mount of the deploy zip. Cuts
        // F1 cold-start from ~60s (file copy + iisnode boot) to ~10s (mount + boot).
        // SCM_DO_BUILD_DURING_DEPLOYMENT=false is mandatory once WEBSITE_RUN_FROM_PACKAGE
        // is enabled: building inside Kudu is redundant (CI already published a Release
        // build) and actively slows the first-request path.
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1'
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
        {
          name: 'ASPNETCORE_ENVIRONMENT'
          value: 'Production'
        }
        {
          name: 'PoMiniGames__ApplicationInsights__ConnectionString'
          value: sharedAppInsights.properties.ConnectionString
        }
        {
          name: 'PoMiniGames__KeyVault__Uri'
          value: sharedKeyVault.properties.vaultUri
        }
        {
          name: 'PoMiniGames__Storage__TableService__AccountName'
          value: storageAccount.name
        }
        {
          // /models/* redirects here (UsePoMiniGamesModelRedirect); see modelsContainer.
          name: 'PoMiniGames__Models__BaseUrl'
          value: 'https://${storageAccount.name}.blob.${environment().suffixes.storage}/models'
        }
        {
          name: 'PoMiniGames__Storage__TableService__Endpoint'
          value: 'https://${storageAccount.name}.table.${environment().suffixes.storage}'
        }
        {
          name: 'PoMiniGames__Storage__TableService__TableName'
          value: appTable.name
        }
        {
          name: 'PoVoxelStrike__ConvertedPath'
          value: 'C:\\home\\data\\povoxelstrike\\converted'
        }
      ]
    }
  }
}

// Existing Resources in PoShared
resource sharedKeyVault 'Microsoft.KeyVault/vaults@2023-02-01' existing = {
  name: sharedKeyVaultName
  scope: resourceGroup(sharedResourceGroupName)
}

resource sharedAppInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: sharedAppInsightsName
  scope: resourceGroup(sharedResourceGroupName)
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    // Allowed so the one 'models' container below can be anonymous-read. Every other container
    // (data-protection keys, PoEcosystem worlds) stays private: access is opted into per container.
    allowBlobPublicAccess: true
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  name: 'default'
  parent: storageAccount
  properties: {
    // The game loaders fetch() the models after the app's /models/* redirect, so they need CORS.
    cors: {
      corsRules: [
        {
          allowedOrigins: [ '*' ]
          allowedMethods: [ 'GET', 'HEAD' ]
          allowedHeaders: [ '*' ]
          exposedHeaders: [ '*' ]
          maxAgeInSeconds: 86400
        }
      ]
    }
  }
}

// The 3D models (~37 MB), uploaded by scripts/pre-deploy.ps1. Served from here instead of the F1
// app, whose 165 MB/day data-out quota a handful of 3D-game players would otherwise use up.
resource modelsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: 'models'
  parent: blobService
  properties: {
    publicAccess: 'Blob'
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  name: 'default'
  parent: storageAccount
}

resource appTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  name: 'pominigames'
  parent: tableService
}

resource webAppTableRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, webApp.id, storageTableDataContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: webApp.identity.principalId
    roleDefinitionId: storageTableDataContributorRoleId
    principalType: 'ServicePrincipal'
  }
}

// Storage Blob Data Contributor — needed by AzureBlobXmlRepository
// (Microsoft.AspNetCore.DataProtection.AzureStorage) for the data-protection
// key escrow blob container. Without this the app fails to start with a
// 403 on Container.CreateIfNotExists.
resource webAppBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, webApp.id, storageBlobDataContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: webApp.identity.principalId
    roleDefinitionId: storageBlobDataContributorRoleId
    principalType: 'ServicePrincipal'
  }
}

output API_URI string = 'https://${webApp.properties.defaultHostName}'
output WEB_APP_NAME string = webApp.name
output WEB_APP_PRINCIPAL_ID string = webApp.identity.principalId
output STORAGE_ACCOUNT_NAME string = storageAccount.name
