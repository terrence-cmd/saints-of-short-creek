<#
Incremental capacity ramp against the raw-photo-converter /convert endpoint.
Coarse ramp (1,2,3,4,5,8,10,15,20,25,30) then bisects on the first full-batch
failure to find the exact failing N. Stops at N=30 (multer's own cap).

A "full failure" (stop condition) is a non-200, a curl exit code != 0, or a
zip that fails to open/has a wrong entry count -- i.e. the whole request died.
A "partial failure" (HTTP 200, zip opens, contains _errors.txt) is the app's
normal per-file error handling working as designed and is logged, not treated
as a stop condition.

Prereqs (set in this shell before running):
  $env:RAWCONV_USER  -- Basic Auth username (see SESSION_HANDOFF.md)
  $env:RAWCONV_PASS  -- Basic Auth password (see SESSION_HANDOFF.md)
  $env:RAWCONV_HOST  -- e.g. "98.92.144.171:3000" (confirm fresh via
                        aws ec2 describe-instances before a real run)

Run the identical script with $env:RAWCONV_HOST = "localhost:3000" via an SSM
RunCommand from the box itself as a control run, to separate "my uplink is
the bottleneck" from "the server has a real ceiling" -- Node's default
300s requestTimeout covers the whole upload, and a naive extrapolation from
the known ~28s/file-1 round trip puts an abort near N=12 during upload,
long before any resource ceiling would be reached from this machine's link.
#>

param(
    [string]$SampleFile = (Join-Path $PSScriptRoot "..\..\..\Downloads\sample-test.ARW"),
    [string]$OutDir = (Join-Path $PSScriptRoot ("runs\{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss"))),
    [int[]]$CoarseSteps = @(1, 2, 3, 4, 5, 8, 10, 15, 20, 25, 30),
    [int]$SettleSeconds = 5
)

if (-not $env:RAWCONV_USER -or -not $env:RAWCONV_PASS -or -not $env:RAWCONV_HOST) {
    Write-Error "Set RAWCONV_USER, RAWCONV_PASS, RAWCONV_HOST env vars first (creds are in SESSION_HANDOFF.md -- do not hardcode them here)."
    exit 1
}
if (-not (Test-Path $SampleFile)) {
    Write-Error "Sample RAW file not found: $SampleFile"
    exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$csvPath = Join-Path $OutDir "results.csv"
"N,StartUtc,EndUtc,HttpCode,TimeTotal,TimeStartTransfer,SizeUpload,SizeDownload,ExitCode,ZipValid,EntryCount,HasErrorsFile,Classification" |
    Out-File -Encoding utf8 $csvPath

# Credentials go in a curl config file (not -u) so they never appear in this
# process's argv / Windows process list. Deleted at the end of the run.
$curlCfgPath = Join-Path $OutDir "curl.cfg"
"user = `"$($env:RAWCONV_USER):$($env:RAWCONV_PASS)`"" | Out-File -Encoding ascii $curlCfgPath

function Invoke-Step {
    param([int]$N)

    $stepZip = Join-Path $OutDir "step-$N.zip"
    $wPath = Join-Path $OutDir "step-$N.wout"
    $timeline = Join-Path $OutDir "step-$N.timeline.csv"

    $fileArgs = @()
    for ($i = 0; $i -lt $N; $i++) { $fileArgs += @("-F", "files=@$SampleFile") }

    $writeOut = "$N,%{time_total},%{time_starttransfer},%{size_upload},%{size_download},%{http_code}"
    $curlArgs = @(
        "-K", $curlCfgPath,
        "--max-time", "400",
        "-w", $writeOut,
        "-o", $stepZip
    ) + $fileArgs + @(
        "-F", "format=jpeg",
        "http://$($env:RAWCONV_HOST)/convert"
    )

    $startUtc = (Get-Date).ToUniversalTime().ToString("o")
    "TimestampUtc,Bytes" | Out-File -Encoding utf8 $timeline

    $proc = Start-Process -FilePath "curl.exe" -ArgumentList $curlArgs -NoNewWindow -PassThru -RedirectStandardOutput $wPath

    while (-not $proc.HasExited) {
        $sz = if (Test-Path $stepZip) { (Get-Item $stepZip).Length } else { 0 }
        "$((Get-Date).ToUniversalTime().ToString('o')),$sz" | Out-File -Append -Encoding utf8 $timeline
        Start-Sleep -Milliseconds 1000
    }
    $exitCode = $proc.ExitCode
    $endUtc = (Get-Date).ToUniversalTime().ToString("o")

    $wOut = (Get-Content $wPath -Raw).Trim()
    $parts = $wOut.Split(",")
    $httpCode = if ($parts.Length -ge 6) { $parts[5] } else { "0" }

    $zipValid = $false
    $entryCount = 0
    $hasErrorsFile = $false
    if (Test-Path $stepZip) {
        try {
            $zip = [System.IO.Compression.ZipFile]::OpenRead($stepZip)
            $entryCount = $zip.Entries.Count
            $hasErrorsFile = ($zip.Entries.Name -contains "_errors.txt")
            $zipValid = $true
            $zip.Dispose()
        } catch {
            $zipValid = $false
        }
    }

    $expectedEntries = if ($hasErrorsFile) { $N + 1 } else { $N }
    $classification =
        if ($httpCode -ne "200" -or $exitCode -ne 0 -or -not $zipValid -or $entryCount -ne $expectedEntries) {
            "FULL_FAILURE"
        } elseif ($hasErrorsFile) {
            "PARTIAL_FAILURE"
        } else {
            "OK"
        }

    "$N,$startUtc,$endUtc,$httpCode,$($parts[1]),$($parts[2]),$($parts[3]),$($parts[4]),$exitCode,$zipValid,$entryCount,$hasErrorsFile,$classification" |
        Out-File -Append -Encoding utf8 $csvPath

    Write-Host "N=$N -> $classification (http=$httpCode exit=$exitCode entries=$entryCount/$expectedEntries time=$($parts[1])s)"
    return $classification
}

$lastGood = 0
$firstFail = $null
foreach ($n in $CoarseSteps) {
    $result = Invoke-Step -N $n
    if ($result -eq "FULL_FAILURE") { $firstFail = $n; break }
    $lastGood = $n
    Start-Sleep -Seconds $SettleSeconds
}

if ($firstFail) {
    Write-Host "Coarse ramp hit full failure at N=$firstFail (last good N=$lastGood). Confirming (not treating one failure as proof)..."
    Start-Sleep -Seconds $SettleSeconds
    $confirm = Invoke-Step -N $firstFail

    if ($confirm -ne "FULL_FAILURE") {
        Write-Host "Re-run of N=$firstFail did NOT reproduce the failure -- likely a fluke (or the server needed a manual restart in between). Inspect $csvPath manually before concluding a threshold."
    } else {
        $lo = $lastGood
        $hi = $firstFail
        while ($hi - $lo -gt 1) {
            $mid = [int](($lo + $hi) / 2)
            Start-Sleep -Seconds $SettleSeconds
            $r = Invoke-Step -N $mid
            if ($r -eq "FULL_FAILURE") { $hi = $mid } else { $lo = $mid }
        }
        Write-Host "Bisection complete: last good N=$lo, first reliably failing N=$hi"
    }
} else {
    Write-Host "All coarse steps up to $($CoarseSteps[-1]) succeeded -- no full failure found within the app's own 30-file batch cap."
}

Remove-Item $curlCfgPath -Force
Write-Host "Results: $csvPath"
Write-Host "Per-step response zips and per-file completion timelines are alongside it in: $OutDir"
