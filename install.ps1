# 安装 zed-dsh-launcher 到本机
# 用法: powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot
$bin = Join-Path $env:USERPROFILE '.dsh\bin'
$desktopDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ss'

if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Force -Path $bin | Out-Null }
if (-not (Test-Path $desktopDir)) { New-Item -ItemType Directory -Force -Path $desktopDir | Out-Null }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$gbk = [System.Text.Encoding]::GetEncoding(936)

function Copy-Utf8($srcRel, $dst) {
    $text = [System.IO.File]::ReadAllText((Join-Path $repo $srcRel), $utf8)
    [System.IO.File]::WriteAllText($dst, $text, $utf8)
    Write-Host "  installed $dst"
}

function Copy-GbkCrlf($srcRel, $dst) {
    $text = [System.IO.File]::ReadAllText((Join-Path $repo $srcRel), $utf8)
    $text = $text -replace "`r?`n", "`r`n"
    [System.IO.File]::WriteAllText($dst, $text, $gbk)
    Write-Host "  installed $dst"
}

Write-Host 'Installing zed-dsh-launcher...'
Copy-Utf8 'src/dshz.js' (Join-Path $bin 'dshz.js')
Copy-Utf8 'remote/zed-status.sh' (Join-Path $bin 'zed-status.sh')
Copy-GbkCrlf 'bin/dshz.cmd' (Join-Path $bin 'dshz.cmd')
Copy-GbkCrlf 'desktop/DSH-Z 控制台.bat' (Join-Path $desktopDir 'DSH-Z 控制台.bat')

Write-Host ''
Write-Host "完成。入口: $(Join-Path $desktopDir 'DSH-Z 控制台.bat')"
Write-Host '首次运行 dshz status 会自动把 zed-status.sh 部署到远端。'
