param(
  [Parameter(Mandatory = $true)][string]$CentralUrl,
  [Parameter(Mandatory = $true)][string]$HelperId,
  [Parameter(Mandatory = $true)][string]$HelperToken
)

$env:STUDIO_CENTRAL_URL = $CentralUrl
$env:STUDIO_HELPER_ID = $HelperId
$env:STUDIO_HELPER_TOKEN = $HelperToken
npm run team:helper
