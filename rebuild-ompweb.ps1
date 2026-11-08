$ErrorActionPreference = 'Stop'
$exitCode = 0
try {
$repo = $PSScriptRoot
$stage = Join-Path $env:TEMP ('ompweb-build-' + [guid]::NewGuid().ToString('N'))
$live = Join-Path $repo '.next\standalone'
$launcher = Join-Path $env:LOCALAPPDATA 'ompweb\start-ompweb.vbs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$preview = $null
$backup = $null

function Invoke-BoundedProcess {
    param([string]$File, [string[]]$Arguments, [string]$WorkingDirectory, [int]$TimeoutSeconds)
    $stdout = Join-Path $env:TEMP ('ompweb-out-' + [guid]::NewGuid().ToString('N') + '.log')
    $stderr = Join-Path $env:TEMP ('ompweb-err-' + [guid]::NewGuid().ToString('N') + '.log')
    try {
        $process = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $null = $process.Handle
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            throw "Process timed out: $File"
        }
        if (Test-Path $stdout) { Get-Content -LiteralPath $stdout | Write-Host }
        if (Test-Path $stderr) { Get-Content -LiteralPath $stderr | Write-Host }
        return $process.ExitCode
    } finally {
        Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    }
}

if (-not (Test-Path (Join-Path $repo 'node_modules'))) { throw 'node_modules not found.' }
if (-not (Test-Path $launcher)) { throw "Launcher not found: $launcher" }
if (Get-NetTCPConnection -LocalPort 30179 -State Listen -ErrorAction SilentlyContinue) { throw 'Preview port 30179 is already in use.' }

Write-Host "Building in $stage"
$copyArgs = @('"' + $repo + '"', '"' + $stage + '"', '/E', '/XJ', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD', '.git', '.next', 'node_modules', '.codegraph', '.tmp')
$copyCode = Invoke-BoundedProcess -File 'robocopy.exe' -Arguments $copyArgs -WorkingDirectory $repo -TimeoutSeconds 120
if ($copyCode -gt 7) { throw "Staging copy failed: $copyCode" }
New-Item -ItemType Junction -Path (Join-Path $stage 'node_modules') -Target (Join-Path $repo 'node_modules') -ErrorAction Stop | Out-Null

$env:CI = '1'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GIT_PAGER = 'cat'
$env:PAGER = 'cat'
$env:TERM = 'dumb'
$buildCode = Invoke-BoundedProcess -File $env:ComSpec -Arguments @('/d', '/s', '/c', ('""' + $npm + '" run build"')) -WorkingDirectory $stage -TimeoutSeconds 600
if ($buildCode -ne 0) { throw "Build failed: $buildCode" }
$stagedStandalone = Join-Path $stage '.next\standalone'
$buildId = (Get-Content -LiteralPath (Join-Path $stagedStandalone '.next\BUILD_ID') -Raw).Trim()
if (-not $buildId) { throw 'Staged BUILD_ID is empty.' }

$previousEnv = @{}
foreach ($name in @('PORT', 'HOSTNAME', 'OMP_WEB_HOSTNAME', 'OMP_WEB_PASSWORD', 'OMPWEB_BACKEND', 'OMP_WEB_PACKAGE_DIR')) { $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:PORT = '30179'
    $env:HOSTNAME = '127.0.0.1'
    $env:OMP_WEB_HOSTNAME = '127.0.0.1'
    $env:OMP_WEB_PASSWORD = [guid]::NewGuid().ToString('N')
    $env:OMPWEB_BACKEND = 'node'
    $env:OMP_WEB_PACKAGE_DIR = $repo
    $preview = Start-Process -FilePath $node -ArgumentList @('--require', '.\bin\request-peer-preload.js', '.\server.js') -WorkingDirectory $stagedStandalone -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 5
    if ($preview.HasExited) { throw 'Preview process exited before verification.' }
    $login = Invoke-WebRequest -Uri 'http://127.0.0.1:30179/login' -UseBasicParsing -TimeoutSec 10
    $manifest = Invoke-WebRequest -Uri ("http://127.0.0.1:30179/_next/static/$buildId/_buildManifest.js") -UseBasicParsing -TimeoutSec 10
    if ($login.StatusCode -ne 200 -or $manifest.StatusCode -ne 200) { throw 'Preview verification failed.' }
    Write-Host "Preview passed. BUILD_ID=$buildId"
} finally {
    if ($preview -and -not $preview.HasExited) { Stop-Process -Id $preview.Id -Force -ErrorAction SilentlyContinue }
    foreach ($name in $previousEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnv[$name], 'Process') }
}

Write-Warning 'Applying restarts ompweb and may terminate active sessions, terminals, and background jobs. Run this script from a separate PowerShell window.'
if ((Read-Host 'Apply this build now? [y/N]') -notmatch '^(?i:y|yes)$') { Write-Host "Cancelled. Staged build: $stage"; return }
$previousBuildId = (Get-Content -LiteralPath (Join-Path $live '.next\BUILD_ID') -Raw).Trim()
if (-not $previousBuildId -or $previousBuildId -eq $buildId) { throw 'The new BUILD_ID is empty or matches the currently installed build; nothing was stopped.' }
Write-Host "Previous BUILD_ID=$previousBuildId"
Write-Host "New BUILD_ID=$buildId"
$owners = @(Get-NetTCPConnection -LocalPort 30177 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -ne 1) { throw 'Expected exactly one owner for port 30177; nothing was stopped.' }
$owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $owners[0]) -ErrorAction Stop
if ($owner.Name -ne 'node.exe' -or $owner.CommandLine -notmatch 'request-peer-preload\.js' -or $owner.CommandLine -notmatch 'server\.js') { throw 'Port owner is not the expected ompweb process; nothing was stopped.' }
$parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $owner.ParentProcessId) -ErrorAction SilentlyContinue
$launcherCmd = Join-Path $env:LOCALAPPDATA 'ompweb\start-ompweb.cmd'
$launcherParentId = if ($parent -and $parent.Name -eq 'cmd.exe' -and $parent.CommandLine -and $parent.CommandLine.Contains($launcherCmd)) { $parent.ProcessId } else { $null }

$stopped = $false
$launched = $false
try {
    Stop-Process -Id $owners[0] -Force -ErrorAction Stop
    $stopped = $true
    if ($launcherParentId) {
        $parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $launcherParentId) -ErrorAction SilentlyContinue
        if ($parent -and $parent.Name -eq 'cmd.exe' -and $parent.CommandLine -and $parent.CommandLine.Contains($launcherCmd)) {
            Stop-Process -Id $launcherParentId -Force -ErrorAction Stop
        }
    }
    Start-Sleep -Seconds 2
    $backup = Join-Path $env:TEMP ('ompweb-standalone-old-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
    $oldItems = [System.Collections.Generic.List[string]]::new()
    $newItems = [System.Collections.Generic.List[string]]::new()
    try {
        foreach ($item in Get-ChildItem -LiteralPath $live -Force) {
            Move-Item -LiteralPath $item.FullName -Destination $backup -ErrorAction Stop
            $oldItems.Add($item.Name)
        }
        foreach ($item in Get-ChildItem -LiteralPath $stagedStandalone -Force) {
            Move-Item -LiteralPath $item.FullName -Destination $live -ErrorAction Stop
            $newItems.Add($item.Name)
        }
    } catch {
        foreach ($name in $newItems) { Move-Item -LiteralPath (Join-Path $live $name) -Destination $stagedStandalone -ErrorAction Stop }
        foreach ($name in $oldItems) { Move-Item -LiteralPath (Join-Path $backup $name) -Destination $live -ErrorAction Stop }
        throw
    }
    if ((Get-Content -LiteralPath (Join-Path $live '.next\BUILD_ID') -Raw).Trim() -ne $buildId) { throw 'Installed BUILD_ID does not match the staged build.' }
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $launcher + '"') -WindowStyle Hidden
    $launched = $true
    Start-Sleep -Seconds 8
    $login = Invoke-WebRequest -Uri 'http://127.0.0.1:30177/login' -UseBasicParsing -TimeoutSec 10
    $finalId = (Get-Content -LiteralPath (Join-Path $live '.next\BUILD_ID') -Raw).Trim()
    $manifest = Invoke-WebRequest -Uri ("http://127.0.0.1:30177/_next/static/$buildId/_buildManifest.js") -UseBasicParsing -TimeoutSec 10
    if ($login.StatusCode -ne 200 -or $manifest.StatusCode -ne 200 -or $finalId -ne $buildId -or $finalId -eq $previousBuildId) { throw 'Live build verification failed.' }
    Write-Host "Applied successfully. BUILD_ID=$finalId"
    Write-Host "Previous build: $backup"
} catch {
    if ($stopped -and -not $launched) { Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $launcher + '"') -WindowStyle Hidden }
    if ($backup) { Write-Warning "Previous build backup: $backup" }
    throw
}
} catch {
    [Console]::Error.WriteLine("Failed: $($_.Exception.Message)")
    $exitCode = 1
} finally {
    if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
        Write-Host 'Press any key to exit...'
        $null = [Console]::ReadKey($true)
    }
}
exit $exitCode
