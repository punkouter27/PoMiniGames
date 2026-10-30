param name string
param location string
param tags object

@description('The name of the existing Key Vault in PoShared')
param sharedKeyVaultName string = 'kv-poshared2'

@description('The name of the existing App Insights in PoShared')
param sharedAppInsightsName string = 'poappideinsights8f9c9a4e'

@description('The name of the resource group containing shared resources')
param sharedResourceGroupName string = 'PoShared'

// ── Microsoft (Entra ID) OAuth configuration (see main.bicep for rationale)
// Client IDs are not secrets; App Settings is the right home. The
// MicrosoftAuthOptionsBinder (PoMiniGames server) auto-promotes `Enabled=true`
// when `FullyConfigured=true` (both ClientId + ApiClientId present), so we
// don't need to push an explicit `Enabled=true` flag here.
param microsoftAuthClientId string = ''
param microsoftAuthApiClientId string = ''
param microsoftAuthTenantId string = tenant().tenantId

var resourceToken = toLower(uniqueString(subscription().id, name, location))
// Solution identity baked into names per Azure Cloud Adoption Framework guidance.
// Names stay stable across SKU/region changes; only the suffix varies.
// Storage account cap: 24 chars lowercase. 'stpominigames' = 14 chars,
// leaving 10 chars for the unique token suffix.
var storageAccountName = toLower('stpominigames${take(resourceToken, 10)}')
var planName           = 'plan-pominigames-${resourceToken}'
var webAppName         = 'app-pominigames-${resourceToken}'
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
  tags: union(tags, { 'azd-service-name': 'api', tier: 'F1', os: 'windows' })
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
          name: 'PoMiniGames__Storage__TableService__Endpoint'
          value: 'https://${storageAccount.name}.table.${environment().suffixes.storage}'
        }
        {
          name: 'PoMiniGames__Storage__TableService__TableName'
          value: appTable.name
        }
        // ── Microsoft (Entra ID) OAuth (App Settings, not KV — these are
        //    public identifiers, not secrets). Wired as Bicep parameters so
        //    each environment can supply its own app registration via
        //    main.parameters.json or `azd env set`. StartupSecretValidator
        //    fails-fast if Production boots without these values.
        {
          name: 'PoMiniGames__MicrosoftAuth__ClientId'
          value: microsoftAuthClientId
        }
        {
          name: 'PoMiniGames__MicrosoftAuth__ApiClientId'
          value: microsoftAuthApiClientId
        }
        {
          name: 'PoMiniGames__MicrosoftAuth__Authority'
          value: '${environment().authentication.loginEndpoint}${microsoftAuthTenantId}/v2.0'
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
  tags: union(tags, { 'azd-service-name': 'storage' })
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
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
