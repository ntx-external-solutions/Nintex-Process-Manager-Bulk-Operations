<#
.SYNOPSIS
    Runs every test file and reports one exit code.

.DESCRIPTION
    Each suite is a standalone script that exits non-zero on failure, so CI can
    call this one file instead of tracking the list.

    Run:  pwsh -NoProfile -File Tests/Run-AllTests.ps1
#>

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$suites = @(
    'Test-Dependencies.ps1'
    'Test-Executor.ps1'
    'Test-BulkDelete.ps1'
    'Test-BulkArchive.ps1'
)

$failed = @()

foreach ($suite in $suites) {
    $path = Join-Path $here $suite
    Write-Host "`n############################################" -ForegroundColor Cyan
    Write-Host "  $suite" -ForegroundColor Cyan
    Write-Host "############################################" -ForegroundColor Cyan

    & (Get-Process -Id $PID).Path -NoProfile -File $path
    if ($LASTEXITCODE -ne 0) { $failed += $suite }
}

Write-Host "`n############################################" -ForegroundColor Cyan
if ($failed.Count -eq 0) {
    Write-Host "  ALL SUITES PASSED" -ForegroundColor Green
    Write-Host "############################################`n" -ForegroundColor Cyan
    exit 0
}

Write-Host "  FAILED: $($failed -join ', ')" -ForegroundColor Red
Write-Host "############################################`n" -ForegroundColor Cyan
exit 1
