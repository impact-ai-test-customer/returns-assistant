targetScope = 'resourceGroup'
param prefix string
param location string
param environment string
param githubEnvironment string
param githubRepository string
param modelName string
param modelVersion string
param modelDeployment string
param modelSku string
param modelCapacity int
param monthlyBudget int
param budgetStart string
param budgetEnd string
param budgetContactEmails array
@description('Tier of the Search service that holds the agent\'s vector stores. Microsoft\'s own template uses standard; basic costs less and suits small knowledge.')
@allowed(['basic', 'standard', 'standard2', 'standard3'])
param searchSku string = 'basic'
@description('Bill the thread store per request (serverless) instead of reserving throughput around the clock.')
param cosmosServerless bool = true

// This inspected profile follows Microsoft's linked standard-setup capabilityHosts template.
// Do not mix capabilitySettings from another API generation into these immutable stores.
var suffix = uniqueString(resourceGroup().id)
var accountName = '${prefix}-${environment}-${suffix}'
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'agent${suffix}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: { minimumTlsVersion: 'TLS1_2'
 allowBlobPublicAccess: false
 allowSharedKeyAccess: false }
}
resource search 'Microsoft.Search/searchServices@2024-06-01-preview' = {
  name: 'agent-${suffix}'
  location: location
  sku: { name: searchSku }
  identity: { type: 'SystemAssigned' }
  properties: { replicaCount: 1
 partitionCount: 1
 hostingMode: 'default'
 disableLocalAuth: true
 publicNetworkAccess: 'enabled' }
}
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: 'agent-${suffix}'
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: cosmosServerless ? [{ name: 'EnableServerless' }] : []
    disableLocalAuth: true
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [{ locationName: location
 failoverPriority: 0
 isZoneRedundant: false }]
  }
}
resource account 'Microsoft.CognitiveServices/accounts@2025-04-01-preview' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: { allowProjectManagement: true
 customSubDomainName: accountName
 disableLocalAuth: true
 publicNetworkAccess: 'Enabled' }
}
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-04-01-preview' = {
  parent: account
  name: environment
  location: location
  identity: { type: 'SystemAssigned' }
  properties: { displayName: '${prefix} ${environment}'
 description: 'Customer-controlled ${environment} agent and data stores' }
}
resource model 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = {
  parent: account
  name: modelDeployment
  sku: { name: modelSku
 capacity: modelCapacity }
  properties: { model: { format: 'OpenAI'
 name: modelName
 version: modelVersion }
 versionUpgradeOption: 'NoAutoUpgrade' }
}
resource storageConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-04-01-preview' = {
  parent: project
  name: 'agent-storage'
  properties: { category: 'AzureStorageAccount'
 target: storage.properties.primaryEndpoints.blob
 authType: 'AAD'
 metadata: { ApiType: 'Azure'
 ResourceId: storage.id
 location: location } }
}
resource searchConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-04-01-preview' = {
  parent: project
  name: 'agent-search'
  properties: { category: 'CognitiveSearch'
 target: 'https://${search.name}.search.windows.net'
 authType: 'AAD'
 metadata: { ApiType: 'Azure'
 ResourceId: search.id
 location: location } }
}
resource cosmosConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-04-01-preview' = {
  parent: project
  name: 'agent-state'
  properties: { category: 'CosmosDB'
 target: cosmos.properties.documentEndpoint
 authType: 'AAD'
 metadata: { ApiType: 'Azure'
 ResourceId: cosmos.id
 location: location } }
}
// Separate stores per environment. These project identities have no access to the other environment.
resource storageRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in [
  '17d1049b-9a84-46fb-8f53-869881c3d3ab' // Storage Account Contributor
  'b7e6dc6d-f1e8-4753-8033-0f276bb0955b' // Blob Data Owner on this dedicated environment store
]: {
  scope: storage
  name: guid(storage.id,project.id,role)
  properties: { principalId: project.identity.principalId
 principalType: 'ServicePrincipal'
 roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions',role) }
}]
resource cosmosOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: cosmos
  name: guid(cosmos.id,project.id,'operator')
  properties: { principalId: project.identity.principalId
 principalType: 'ServicePrincipal'
 roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','230815da-be43-4aae-9cb4-875f7bd000aa') }
}
resource searchRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in [
  '8ebe5a00-799e-43f5-93ac-243d3dce84a7' // Search Index Data Contributor
  '7ca78c08-252a-4471-8644-bb5ff32d4ba0' // Search Service Contributor
]: {
  scope: search
  name: guid(search.id,project.id,role)
  properties: { principalId: project.identity.principalId
 principalType: 'ServicePrincipal'
 roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions',role) }
}]
resource accountHost 'Microsoft.CognitiveServices/accounts/capabilityHosts@2025-04-01-preview' = {
  parent: account
  name: 'agents'
  properties: { capabilityHostKind: 'Agents' }
}
resource projectHost 'Microsoft.CognitiveServices/accounts/projects/capabilityHosts@2025-04-01-preview' = {
  parent: project
  name: 'agents'
  properties: { storageConnections: [storageConnection.name]
 vectorStoreConnections: [searchConnection.name]
 threadStorageConnections: [cosmosConnection.name] }
  dependsOn: [accountHost
 storageRoles
 cosmosOperator
 searchRoles]
}
resource cosmosData 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id,project.id,'data')
  properties: {
    principalId: project.identity.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: '${cosmos.id}/dbs/enterprise_memory'
  }
  dependsOn: [projectHost]
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'agent-${suffix}'
  location: location
  properties: { sku: { name: 'PerGB2018' }
 retentionInDays: 30 }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'agent-${suffix}'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web'
 WorkspaceResourceId: logs.id }
}
resource insightsConnection 'Microsoft.CognitiveServices/accounts/connections@2025-04-01-preview' = {
  parent: account
  name: 'agent-traces'
  properties: { category: 'AppInsights'
 target: insights.id
 authType: 'ApiKey'
 isSharedToAll: true
 credentials: { key: insights.properties.ConnectionString }
 metadata: { ApiType: 'Azure'
 ResourceId: insights.id } }
}
resource releaseIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'agent-release-${environment}'
  location: location
}
resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: releaseIdentity
  name: 'github-environment'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:environment:${githubEnvironment}'
    audiences: ['api://AzureADTokenExchange']
  }
}
// Setup runs as the customer Owner. The pipeline receives no Owner or role-assignment privilege.
resource releaseContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id,releaseIdentity.id,'contributor')
  properties: { principalId: releaseIdentity.properties.principalId
 principalType: 'ServicePrincipal'
 roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','b24988ac-6180-42a0-ab88-20f7382dd24c') }
}
resource releaseFoundry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: project
  name: guid(project.id,releaseIdentity.id,'foundry-user')
  properties: { principalId: releaseIdentity.properties.principalId
 principalType: 'ServicePrincipal'
 roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','53ca6127-db72-4b80-b1b0-d745d6d5456d') }
}
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'agent-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStart
 endDate: budgetEnd }
    notifications: {
      eightyPercent: { enabled: true
 operator: 'GreaterThanOrEqualTo'
 threshold: 80
 thresholdType: 'Actual'
 contactEmails: budgetContactEmails }
      fullBudget: { enabled: true
 operator: 'GreaterThanOrEqualTo'
 threshold: 100
 thresholdType: 'Actual'
 contactEmails: budgetContactEmails }
    }
  }
}
output projectId string = project.id
output endpoint string = 'https://${account.name}.services.ai.azure.com/api/projects/${project.name}'
output clientId string = releaseIdentity.properties.clientId

// The customer publishes full replay input here. Versioned reads are limited to this one private container.
resource inputBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
  }
}
resource releaseInputs 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: inputBlobService
  name: 'release-inputs'
  properties: {
    publicAccess: 'None'
  }
}
resource releaseInputReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: releaseInputs
  name: guid(releaseInputs.id,releaseIdentity.id,'input-reader')
  properties: {
    principalId: releaseIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions','2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
  }
}
output privateBundleContainerUrl string = '${storage.properties.primaryEndpoints.blob}release-inputs'
