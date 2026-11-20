param keyVaultName string
param storageAccountName string
param solutionName string = 'PoMiniGames'

resource sharedKeyVault 'Microsoft.KeyVault/vaults@2023-02-01' existing = {
  name: keyVaultName
}

resource storageAccountSecret 'Microsoft.KeyVault/vaults/secrets@2023-02-01' = {
  parent: sharedKeyVault
  name: '${solutionName}--StorageAccountName'
  properties: {
    value: storageAccountName
  }
}
