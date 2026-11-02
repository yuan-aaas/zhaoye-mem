$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('zhaoye-process-' + [guid]::NewGuid())
$node = (Get-Command node.exe -ErrorAction Stop).Source
$cli = Join-Path $workspace 'packages/cli/dist/bin.js'
$worker = Join-Path $workspace 'tests/integration/presence-worker.mjs'
$holder = $null
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Start-Holder([string]$Ready, [string]$Stop) {
  $config = @{ root = (Join-Path $taskRoot 'data'); ready = $Ready; stop = $Stop } | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config))
  return Start-Process -FilePath $node -ArgumentList @(('"' + $worker + '"'), $encoded) -PassThru -WindowStyle Hidden
}
function Wait-Ready([string]$Path, $Process) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $Path)) {
    if ($Process.HasExited) { throw 'Holder exited before becoming ready.' }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Holder readiness timeout.' }
    Start-Sleep -Milliseconds 25
  }
  $result = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  Assert-True $result.ok 'Holder failed to acquire data root.'
}
try {
  New-Item -ItemType Directory -Path $taskRoot | Out-Null
  $dataRoot = Join-Path $taskRoot 'data'
  $initial = & $node $cli init --data-root $dataRoot --json | ConvertFrom-Json
  Assert-True ($LASTEXITCODE -eq 0 -and $initial.ok) 'CLI init failed.'
  $ready = Join-Path $taskRoot 'ready.json'
  $stop = Join-Path $taskRoot 'stop'
  $holder = Start-Holder $ready $stop
  Wait-Ready $ready $holder
  $blocked = & $node $cli identity show --data-root $dataRoot --json | ConvertFrom-Json
  Assert-True ($LASTEXITCODE -eq 3 -and $blocked.error.code -eq 'ASSISTANT_PRESENT_ELSEWHERE') 'Second live process was not rejected.'
  $diagnosis = & $node $cli doctor --data-root $dataRoot --json | ConvertFrom-Json
  Assert-True ($LASTEXITCODE -eq 0 -and $diagnosis.data.presence.state -eq 'active') 'Read-only doctor failed while occupied.'
  New-Item -ItemType File -Path $stop | Out-Null
  Assert-True ($holder.WaitForExit(15000)) 'Holder did not release.'
  Assert-True ($holder.ExitCode -eq 0) 'Holder close failed.'
  $holder = $null
  $shown = & $node $cli identity show --data-root $dataRoot --json | ConvertFrom-Json
  Assert-True ($LASTEXITCODE -eq 0 -and $shown.ok) 'Could not open after graceful release.'
  $ready2 = Join-Path $taskRoot 'ready2.json'
  $holder = Start-Holder $ready2 (Join-Path $taskRoot 'never-stop')
  Wait-Ready $ready2 $holder
  Stop-Process -Id $holder.Id -Force
  $holder.WaitForExit()
  $holder = $null
  $recovered = & $node $cli identity show --data-root $dataRoot --json | ConvertFrom-Json
  Assert-True ($LASTEXITCODE -eq 0 -and $recovered.ok) 'Dead owner could not be taken over.'
  $blockedRoot = Join-Path $taskRoot 'acl-readonly'
  New-Item -ItemType Directory -Path $blockedRoot | Out-Null
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  try {
    & icacls.exe $blockedRoot /deny ("*" + $sid + ':(OI)(CI)(W)') | Out-Null
    Assert-True ($LASTEXITCODE -eq 0) 'Could not prepare read-only ACL fixture.'
    $denied = & $node $cli init --data-root $blockedRoot --json | ConvertFrom-Json
    Assert-True ($LASTEXITCODE -eq 6 -and $denied.error.code -eq 'STORAGE_FAILURE') 'Read-only data root did not return STORAGE_FAILURE.'
  } finally {
    & icacls.exe $blockedRoot /remove:d ("*" + $sid) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restore ACL fixture permissions.' }
  }
  Assert-True (@(Get-ChildItem -LiteralPath $blockedRoot -Force).Count -eq 0) 'Denied init wrote unexpected files.'
  Write-Output 'Cross-process acceptance: live owner rejected; doctor read-only; graceful release; crash takeover passed.'
  Write-Output 'Windows ACL acceptance: write denied; STORAGE_FAILURE returned; no files created.'
} finally {
  if ($null -ne $holder -and -not $holder.HasExited) { Stop-Process -Id $holder.Id -Force; $holder.WaitForExit() }
  if (Test-Path -LiteralPath $taskRoot) {
    $resolved = (Resolve-Path -LiteralPath $taskRoot).Path
    $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not $resolved.StartsWith(($tempParent + '\'), [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFileName($resolved).StartsWith('zhaoye-process-'))) { throw 'Refusing unsafe temporary cleanup.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
