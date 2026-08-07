$ErrorActionPreference = "SilentlyContinue"

$ProjectDir = "C:\Users\99632\Documents\Codex\2026-05-15\gpt-a"
$NodeExe = "C:\Program Files\nodejs\node.exe"
$Port = 48080

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  exit 0
}

$stdout = Join-Path $ProjectDir "server.out.log"
$stderr = Join-Path $ProjectDir "server.err.log"

$env:PORT = [string]$Port
Start-Process `
  -FilePath $NodeExe `
  -ArgumentList "server.js" `
  -WorkingDirectory $ProjectDir `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -WindowStyle Hidden
