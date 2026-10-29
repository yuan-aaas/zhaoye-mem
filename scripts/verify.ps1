$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$node = $nodeCommand.Source
$tsc = Join-Path $root 'node_modules/.bin/tsc.cmd'
$biome = Join-Path $root 'node_modules/.bin/biome.cmd'
$depcruise = Join-Path $root 'node_modules/.bin/depcruise.cmd'

foreach ($tool in @($tsc, $biome, $depcruise)) {
  if (-not (Test-Path -LiteralPath $tool)) {
    throw "Missing local tool: $tool. Run pnpm install --frozen-lockfile first."
  }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

$packages = @(
  'packages/contracts',
  'packages/storage',
  'packages/core',
  'packages/adapter-kit',
  'packages/app',
  'packages/cli',
  'plugins/dsh',
  'plugins/mcp'
)

Push-Location $root
try {
  Invoke-Checked 'Version check' { & $node 'scripts/check-versions.mjs' }

  foreach ($package in $packages) {
    Invoke-Checked "$package build" { & $tsc -p (Join-Path $package 'tsconfig.build.json') }
    Invoke-Checked "$package test compile" { & $tsc -p (Join-Path $package 'tsconfig.test.json') }
  }
  Invoke-Checked 'Root test compile' { & $tsc -p 'tests/tsconfig.json' }

  foreach ($package in $packages) {
    Invoke-Checked "$package source typecheck" { & $tsc -p (Join-Path $package 'tsconfig.build.json') --noEmit }
    Invoke-Checked "$package test typecheck" { & $tsc -p (Join-Path $package 'tsconfig.test.json') --noEmit }
  }

  Invoke-Checked 'Lint' { & $biome 'check' '.' }
  Invoke-Checked 'Architecture' { & $depcruise '--config' '.dependency-cruiser.cjs' 'packages' 'plugins' }
  Invoke-Checked 'Tests' { & $node 'scripts/run-tests.mjs' }
} finally {
  Pop-Location
}
