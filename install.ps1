# 安装 dsh-zed 到本机
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

Write-Host 'Installing dsh-zed...'

# 清理旧命名（dshz）留下的文件
foreach ($old in @('dshz.js', 'dshz.cmd')) {
    $path = Join-Path $bin $old
    if (Test-Path $path) { Remove-Item $path -Force; Write-Host "  removed legacy $path" }
}

Copy-Utf8 'src/dsh-zed.js' (Join-Path $bin 'dsh-zed.js')
Copy-Utf8 'src/ui.js' (Join-Path $bin 'ui.js')
Copy-Utf8 'remote/zed-status.sh' (Join-Path $bin 'zed-status.sh')
Copy-Utf8 'link-zed-threads.js' (Join-Path $bin 'link-zed-threads.js')

$webTarget = Join-Path $bin 'web'
if (-not (Test-Path $webTarget)) { New-Item -ItemType Directory -Force -Path $webTarget | Out-Null }
foreach ($file in Get-ChildItem (Join-Path $repo 'src\web') -File) {
    Copy-Utf8 ('src/web/' + $file.Name) (Join-Path $webTarget $file.Name)
}

Copy-GbkCrlf 'bin/dsh-zed.cmd' (Join-Path $bin 'dsh-zed.cmd')
# 桌面入口默认不复制；直接用仓库 desktop\*.bat

Write-Host ''
Write-Host "完成。入口: $(Join-Path $desktopDir 'DSH-Z 控制台.bat')"
Write-Host '首次运行 dsh-zed status 会自动把 zed-status.sh 部署到远端。'
