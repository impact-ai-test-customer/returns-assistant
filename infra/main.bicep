targetScope = 'subscription'

@description('Short lowercase prefix, unique in the subscription.')
@minLength(3)
@maxLength(12)
param prefix string
param location string
@description('Exact owner/repository allowed to exchange GitHub environment OIDC tokens.')
param githubRepository string
@description('Explicit model identity and version; check regional availability and quota first.')
param modelName string
param modelVersion string
param modelDeployment string
param modelSku string
@minValue(1)
param modelCapacity int
@minValue(1)
param monthlyBudget int
@description('First day of the current month, ISO 8601; chosen by the owner.')
param budgetStart string
@description('End date of the budget period, ISO 8601; chosen by the owner.')
param budgetEnd string
param budgetContactEmails array
@description('Tier of each environment\'s Search service; basic unless the knowledge needs more.')
@allowed(['basic', 'standard', 'standard2', 'standard3'])
param searchSku string = 'basic'
@description('Serverless thread store in each environment unless throughput must be reserved.')
param cosmosServerless bool = true

var environments = [
  { name: 'development'
 github: 'Development' }
  { name: 'production'
 github: 'Production' }
]
resource groups 'Microsoft.Resources/resourceGroups@2024-03-01' = [for env in environments: {
  name: '${prefix}-${env.name}'
  location: location
  tags: { purpose: 'customer-agent'
 environment: env.name }
}]
module setup 'environment.bicep' = [for (env,i) in environments: {
  name: '${prefix}-${env.name}'
  scope: groups[i]
  params: {
    prefix: prefix
    location: location
    environment: env.name
    githubEnvironment: env.github
    githubRepository: githubRepository
    modelName: modelName
    modelVersion: modelVersion
    modelDeployment: modelDeployment
    modelSku: modelSku
    modelCapacity: modelCapacity
    monthlyBudget: monthlyBudget
    budgetStart: budgetStart
    budgetEnd: budgetEnd
    budgetContactEmails: budgetContactEmails
    searchSku: searchSku
    cosmosServerless: cosmosServerless
  }
}]
output environments array = [for (env,i) in environments: {
  environment: env.name
  githubEnvironment: env.github
  resourceGroup: groups[i].name
  projectId: setup[i].outputs.projectId
  endpoint: setup[i].outputs.endpoint
  clientId: setup[i].outputs.clientId
  privateBundleContainerUrl: setup[i].outputs.privateBundleContainerUrl
  tenantId: tenant().tenantId
  subscriptionId: subscription().subscriptionId
}]
