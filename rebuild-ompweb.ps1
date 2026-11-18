$ErrorActionPreference = 'Stop'
$exitCode = 0
try {
$repo = $PSScriptRoot
$stage = Join-Path $env:TEMP ('ompweb-build-' + [guid]::NewGuid().ToString('N'))
$live = Join-Path $repo '.next'
$launcher = Join-Path $env:LOCALAPPDATA 'ompweb\start-ompweb.vbs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$preview = $null
$backup = $null
$backupBuild = $null

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
        if (Test-Path $stdout) { Get-Content -LiteralPath $stdout -Encoding UTF8 | Write-Host }
        if (Test-Path $stderr) { Get-Content -LiteralPath $stderr -Encoding UTF8 | Write-Host }
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
$stagedBuild = Join-Path $stage '.next'
$stagedStandalone = Join-Path $stagedBuild 'standalone'
$buildId = (Get-Content -LiteralPath (Join-Path $stagedBuild 'BUILD_ID') -Raw).Trim()
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
$liveBuildIdPath = Join-Path $live 'BUILD_ID'
$previousBuildId = if (Test-Path -LiteralPath $liveBuildIdPath) { (Get-Content -LiteralPath $liveBuildIdPath -Raw).Trim() } else { $null }
if ($previousBuildId -and $previousBuildId -eq $buildId) { Write-Warning 'The staged BUILD_ID matches the installed build; it will be reinstalled/restarted if needed.' }
if ($previousBuildId) { Write-Host "Previous BUILD_ID=$previousBuildId" } else { Write-Host 'Previous BUILD_ID=(none; first install)' }
Write-Host "New BUILD_ID=$buildId"
if (Get-NetTCPConnection -LocalPort 30178 -State Listen -ErrorAction SilentlyContinue) { throw 'Development server port 30178 is in use; stop it before replacing the shared .next directory.' }
$owners = @(Get-NetTCPConnection -LocalPort 30177 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
$owner = $null
$parent = $null
$launcherParentId = $null
if ($owners.Count -gt 1) { throw "Expected zero or one owner for port 30177; found $($owners.Count)." }
if ($owners.Count -eq 1) {
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $owners[0]) -ErrorAction Stop
    $parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $owner.ParentProcessId) -ErrorAction SilentlyContinue
}
$cliPreloadPath = [regex]::Escape((Join-Path $repo 'bin\request-peer-preload.js'))
$cliNextPath = [regex]::Escape((Join-Path $repo 'node_modules\next\dist\bin\next'))
$cliWrapperPath = [regex]::Escape((Join-Path $repo 'bin\omp-web.js'))
$launcherCmd = Join-Path $env:LOCALAPPDATA 'ompweb\start-ompweb.cmd'
if ($owners.Count -eq 1) {
    $isExpectedCli = $owner.Name -eq 'node.exe' -and
        $owner.CommandLine -match $cliPreloadPath -and
        $owner.CommandLine -match $cliNextPath -and
        $owner.CommandLine -match '(?i)\bstart\s+-p\s+30177\b' -and
        $parent -and $parent.Name -eq 'node.exe' -and
        $parent.CommandLine -match $cliWrapperPath -and
        $parent.CommandLine -match '(?i)--port\s+30177\b'
    if (-not $isExpectedCli) { throw 'Port 30177 is occupied by a non-ompweb process; nothing was stopped.' }
    $launcherParentId = if ($parent -and $parent.Name -eq 'cmd.exe' -and $parent.CommandLine -and $parent.CommandLine.Contains($launcherCmd)) { $parent.ProcessId } else { $null }
    Write-Host "Existing ompweb process detected (PID=$($owners[0])); it will be restarted."
} else {
    Write-Host 'No ompweb process is listening on port 30177; the new process will be started after installation.'
}

$stopped = $false
$launched = $false
try {
    if ($owners.Count -eq 1) {
        Stop-Process -Id $owners[0] -Force -ErrorAction Stop
        $stopped = $true
        if ($launcherParentId) {
            $parent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $launcherParentId) -ErrorAction SilentlyContinue
            if ($parent -and $parent.Name -eq 'cmd.exe' -and $parent.CommandLine -and $parent.CommandLine.Contains($launcherCmd)) {
                Stop-Process -Id $launcherParentId -Force -ErrorAction Stop
            }
        }
        Start-Sleep -Seconds 2
    }
    if (Test-Path -LiteralPath $live) {
        $backup = Join-Path $env:TEMP ('ompweb-next-old-' + [guid]::NewGuid().ToString('N'))
        $backupBuild = Join-Path $backup '.next'
        New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
    } else {
        Write-Host 'No existing .next build found; installing as a fresh build.'
    }
    $installOk = $false
    $attempt = 0
    while (-not $installOk) {
        $attempt++
        $candidate = Join-Path $repo ('.next-install-' + [guid]::NewGuid().ToString('N'))
        $failedPath = Join-Path $stage ('.next-install-failed-' + $attempt)
        try {
            New-Item -ItemType Directory -Path $candidate -ErrorAction Stop | Out-Null
            foreach ($item in Get-ChildItem -LiteralPath $stagedBuild -Force) {
                Copy-Item -LiteralPath $item.FullName -Destination $candidate -Recurse -Force -ErrorAction Stop
            }
            if ((Get-Content -LiteralPath (Join-Path $candidate 'BUILD_ID') -Raw).Trim() -ne $buildId) { throw 'Copied build candidate has the wrong BUILD_ID.' }
            if (Test-Path -LiteralPath $live) { Move-Item -LiteralPath $live -Destination $backupBuild -ErrorAction Stop }
            Move-Item -LiteralPath $candidate -Destination $live -ErrorAction Stop
            if ((Get-Content -LiteralPath (Join-Path $live 'BUILD_ID') -Raw).Trim() -ne $buildId) { throw 'Installed BUILD_ID does not match the staged build.' }
            $installOk = $true
            break
        } catch {
            $installError = $_.Exception.Message
            if ($backupBuild -and (Test-Path -LiteralPath $live) -and (Test-Path -LiteralPath $backupBuild)) {
                Move-Item -LiteralPath $live -Destination $failedPath -ErrorAction Stop
            }
            if ($backupBuild -and (Test-Path -LiteralPath $backupBuild) -and -not (Test-Path -LiteralPath $live)) {
                Move-Item -LiteralPath $backupBuild -Destination $live -ErrorAction Stop
            }
            if (Test-Path -LiteralPath $candidate) {
                Move-Item -LiteralPath $candidate -Destination ($failedPath + '-candidate') -ErrorAction Stop
            }
            $retryInstall = Read-Host "Install attempt $attempt failed: $installError`nRetry this build install? [y/N]"
            if ($retryInstall -notmatch '^(?i:y|yes)$') { throw "Install cancelled after failure; old build restored: $installError" }
            Write-Host 'Retrying the install from the already-built files.'
        }
    }
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $launcher + '"') -WindowStyle Hidden
    $launched = $true
    Start-Sleep -Seconds 8
    $finalId = (Get-Content -LiteralPath (Join-Path $live 'BUILD_ID') -Raw).Trim()
    if ($finalId -ne $buildId) { throw 'Installed BUILD_ID does not match the staged build.' }
    $liveOwners = @(Get-NetTCPConnection -LocalPort 30177 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($liveOwners.Count -ne 1) { throw 'Build is installed, but the expected server is not listening on port 30177.' }
    $liveOwner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $liveOwners[0]) -ErrorAction Stop
    $liveParent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $liveOwner.ParentProcessId) -ErrorAction SilentlyContinue
    $isLiveCli = $liveOwner.Name -eq 'node.exe' -and
        $liveOwner.CommandLine -match $cliPreloadPath -and
        $liveOwner.CommandLine -match $cliNextPath -and
        $liveOwner.CommandLine -match '(?i)\bstart\s+-p\s+30177\b' -and
        $liveParent -and $liveParent.Name -eq 'node.exe' -and
        $liveParent.CommandLine -match $cliWrapperPath -and
        $liveParent.CommandLine -match '(?i)--port\s+30177\b'
    if (-not $isLiveCli) { throw 'Build is installed, but port 30177 is not owned by the expected ompweb CLI process.' }
    try {
        $login = Invoke-WebRequest -Uri 'http://127.0.0.1:30177/login' -UseBasicParsing -TimeoutSec 10
        $manifest = Invoke-WebRequest -Uri ("http://127.0.0.1:30177/_next/static/$buildId/_buildManifest.js") -UseBasicParsing -TimeoutSec 10
        if ($login.StatusCode -ne 200 -or $manifest.StatusCode -ne 200) { throw 'Login or build manifest returned a non-200 response.' }
        Write-Host "Applied and verified successfully. BUILD_ID=$finalId"
    } catch {
        Write-Warning "Build is installed and the ompweb process is listening, but HTTP verification did not complete: $($_.Exception.Message)"
        Write-Host "Build installed with verification warning. BUILD_ID=$finalId"
    }
    Write-Host "Previous build backup: $backupBuild"
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
