# 把 coopanion-world-threads 装进 Coopanion 的扩展目录。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -ExtensionsDir "D:\...\data\extensions"
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Enable   # 顺手把 worlds.threads.enabled 设为 true
#
# 不删除任何东西：已存在的包会改名成 .bak-<时间> 留档。
[CmdletBinding()]
param(
  [string]$ExtensionsDir = '',
  [switch]$Enable
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$packageName = 'coopanion-world-threads'

# ── 1. 找扩展目录与数据根 ────────────────────────────────────────────────
$dataRoot = ''
if (-not $ExtensionsDir -and $env:CORTICO_EXTENSIONS_DIR) {
  $ExtensionsDir = $env:CORTICO_EXTENSIONS_DIR
}
if (-not $ExtensionsDir) {
  $loc = Join-Path $env:LOCALAPPDATA 'Coopanion\data-location.json'
  if (Test-Path -LiteralPath $loc) {
    $dataRoot = (Get-Content -LiteralPath $loc -Raw -Encoding UTF8 | ConvertFrom-Json).data
    if ($dataRoot) { $ExtensionsDir = Join-Path $dataRoot 'extensions' }
  }
}
if (-not $ExtensionsDir) {
  throw '找不到 Coopanion 的 extensions 目录。请用 -ExtensionsDir 指定，例如 D:\Coopanion-Setup-0.2.8\data\extensions'
}
$ExtensionsDir = [System.IO.Path]::GetFullPath($ExtensionsDir)
if (-not (Test-Path -LiteralPath $ExtensionsDir)) {
  throw "扩展目录不存在：$ExtensionsDir"
}
if (-not $dataRoot) { $dataRoot = Split-Path -Parent $ExtensionsDir }
if (-not (Test-Path -LiteralPath (Join-Path $ExtensionsDir 'package.json'))) {
  throw "这个目录不像 Coopanion 的扩展目录（缺 package.json）：$ExtensionsDir"
}

Write-Host "扩展目录：$ExtensionsDir"

# ── 2. 复制包 ────────────────────────────────────────────────────────────
# 先放一份到 .local/（package.json 里以 file: 依赖指向它），
# 再复制到 node_modules/ 让当前的装载器马上能读到。
$store = Join-Path (Join-Path $ExtensionsDir '.local') $packageName
if (Test-Path -LiteralPath $store) { Remove-Item -LiteralPath $store -Recurse -Force }
New-Item -ItemType Directory -Path $store -Force | Out-Null
foreach ($item in @('src', 'dist', 'scripts', 'package.json', 'describe.json', 'README.md', 'DESIGN.md', 'LICENSE')) {
  $from = Join-Path $packageRoot $item
  if (Test-Path -LiteralPath $from) {
    Copy-Item -LiteralPath $from -Destination $store -Recurse -Force
  }
}

$nodeModules = Join-Path $ExtensionsDir 'node_modules'
New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null
$target = Join-Path $nodeModules $packageName
if (Test-Path -LiteralPath $target) {
  $backup = "$target.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
  Move-Item -LiteralPath $target -Destination $backup
  Write-Host "旧版本已移到：$backup"
}
Copy-Item -LiteralPath $store -Destination $target -Recurse -Force
Write-Host "包已放到：$store"
Write-Host "并复制到：$target"

# ── 3. 把依赖写进 extensions/package.json ───────────────────────────────
$pkgFile = Join-Path $ExtensionsDir 'package.json'
Copy-Item -LiteralPath $pkgFile -Destination "$pkgFile.bak-threads" -Force
$pkg = Get-Content -LiteralPath $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ($pkg.PSObject.Properties.Name -contains 'dependencies') -or $null -eq $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$spec = "file:./.local/$packageName"
$pkg.dependencies | Add-Member -NotePropertyName $packageName -NotePropertyValue $spec -Force
$pkg | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $pkgFile -Encoding UTF8
Write-Host "已在 package.json 的 dependencies 里登记 $packageName → $spec（备份：$pkgFile.bak-threads）"

# ── 4. 可选：默认启用 ────────────────────────────────────────────────────
if ($Enable) {
  $homeDir = Join-Path $dataRoot 'home'
  $deployment = $null
  if (Test-Path -LiteralPath $homeDir) {
    $deployment = Get-ChildItem -LiteralPath $homeDir -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'deployment.json') } |
      Select-Object -First 1
  }
  if (-not $deployment) {
    Write-Warning "找不到部署目录（$homeDir\*\deployment.json），没有自动启用。请重启后在扩展页手动开启。"
  } else {
    $cfgFile = Join-Path $deployment.FullName 'config.json'
    Copy-Item -LiteralPath $cfgFile -Destination "$cfgFile.bak-threads" -Force
    $cfg = Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not ($cfg.PSObject.Properties.Name -contains 'worlds') -or $null -eq $cfg.worlds) {
      $cfg | Add-Member -NotePropertyName worlds -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if (-not ($cfg.worlds.PSObject.Properties.Name -contains 'threads') -or $null -eq $cfg.worlds.threads) {
      $cfg.worlds | Add-Member -NotePropertyName threads -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $cfg.worlds.threads | Add-Member -NotePropertyName enabled -NotePropertyValue $true -Force
    $cfg | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $cfgFile -Encoding UTF8
    Write-Host "已把 worlds.threads.enabled 设为 true（备份：$cfgFile.bak-threads）"
  }
}

# ── 5. 下一步 ────────────────────────────────────────────────────────────
if (Get-Process -Name 'Coopanion' -ErrorAction SilentlyContinue) {
  Write-Host ''
  Write-Host '检测到 Coopanion 正在运行：请退出并重新打开，扩展才会被加载。' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 重启 Coopanion'
Write-Host '  2. 设置 → 扩展 / World 页，找到「多线程」，点开启'
if ($Enable) { Write-Host '     （已用 -Enable 预先设为开启，重启后应自动挂载）' }
Write-Host '  3. 对桌宠说「帮我想三个点子」或「把这段整理成要点」，看线程池面板'
