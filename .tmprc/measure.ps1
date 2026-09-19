$ErrorActionPreference = 'SilentlyContinue'
$env:NODE_ENV = 'test'
$env:PENECHO_STATE_DIR = Join-Path $env:TEMP ('fastmem-' + [guid]::NewGuid().ToString('N'))
$repo = 'C:\Users\Asus\Desktop\(''-'')\Development\FastLectures'
Set-Location $repo
$p = Start-Process -FilePath 'node' -ArgumentList 'src/server/main.js' -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\fl-out.txt" -RedirectStandardError "$env:TEMP\fl-err.txt"
Start-Sleep -Seconds 12
$tree = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id) OR ParentProcessId=$($p.Id)" |
  Select-Object ProcessId, Name, @{n='RSS_MB';e={[math]::Round($_.WorkingSetSize/1MB,1)}}
$tree | Format-Table -AutoSize | Out-String | Write-Output
$total = ($tree | Measure-Object -Property RSS_MB -Sum).Sum
Write-Output "TOTAL_TREE_RSS_MB=$([math]::Round($total,1))"
Write-Output "PROC_COUNT=$(@($tree).Count)"
Write-Output "--- stdout (first 700 chars) ---"
(Get-Content "$env:TEMP\fl-out.txt" -Raw).Substring(0, [Math]::Min(700, (Get-Content "$env:TEMP\fl-out.txt" -Raw).Length))
Write-Output "--- stderr (first 300 chars) ---"
$e = Get-Content "$env:TEMP\fl-err.txt" -Raw
if ($e) { $e.Substring(0, [Math]::Min(300, $e.Length)) }
Stop-Process -Id $p.Id -Force
Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item $env:PENECHO_STATE_DIR -Recurse -Force
