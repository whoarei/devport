param([string]$InstallerScript = 'src-tauri/target/release/nsis/x64/installer.nsi')
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = (Resolve-Path (Join-Path $workspace $InstallerScript)).Path
$nsisDir = Split-Path $source
$compiler = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
$id = [guid]::NewGuid().ToString('N')
$name = "DevPortSmoke_$id"
$legacyName = "DevPortLegacy_$id"
$root = Join-Path $workspace "artifacts/installer-smoke/$id"
New-Item -ItemType Directory -Path $root | Out-Null
$oldDir = Join-Path $root 'old install'
$newDir = Join-Path $root 'new install'
$registryRoot = "Software\DevPortInstallerTests\$id"
$oldKey = "$registryRoot\legacy-uninstall"
$oldInstallKey = "$registryRoot\legacy-location"
$newKey = "$registryRoot\new-uninstall"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$oldBinary = "$legacyName.exe"
$newBinary = "$name.exe"
function Assert($condition, $message) { if (!$condition) { throw $message } }
function NsisString([string]$value) { return $value.Replace('$', '$$').Replace('"', '$\"') }
function RunInstaller([string]$file, [string[]]$arguments) {
  $process = Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  Assert ($process.ExitCode -eq 0) "Installer failed: $($process.ExitCode)"
}
function Compile([string]$script) {
  & $compiler /V2 $script | Out-Host
  Assert ($LASTEXITCODE -eq 0) 'NSIS fixture compilation failed'
}

try {
  $seed = @'
Unicode true
RequestExecutionLevel user
Name "Legacy fixture"
OutFile "@SEED@"
InstallDir "@OLD@"
Section
  SetRegView 64
  SetShellVarContext current
  SetOutPath $INSTDIR
  File /oname=@BINARY@ "@PAYLOAD@"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "@KEY@" "InstallLocation" '$\"$INSTDIR$\"'
  WriteRegStr HKCU "@KEY@" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "@KEY@" "MainBinaryName" "@BINARY@"
  WriteRegStr HKCU "@LOCATION@" "" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "@RUN@" '$INSTDIR\@BINARY@ --minimized'
  CreateShortcut "$DESKTOP\@SHORTCUT@.lnk" "$INSTDIR\@BINARY@"
  CreateShortcut "$SMPROGRAMS\@SHORTCUT@.lnk" "$INSTDIR\@BINARY@"
SectionEnd
Section Uninstall
  SetRegView 64
  Delete "$INSTDIR\@BINARY@"
  DeleteRegKey HKCU "@KEY@"
SectionEnd
'@
  $seedExe = Join-Path $root 'seed.exe'
  foreach ($replacement in @{
    '@SEED@'=$seedExe; '@OLD@'=$oldDir; '@BINARY@'=$oldBinary; '@PAYLOAD@'=(Join-Path $env:WINDIR 'System32/whoami.exe');
    '@KEY@'=$oldKey; '@LOCATION@'=$oldInstallKey; '@RUN@'=$legacyName; '@SHORTCUT@'=$legacyName
  }.GetEnumerator()) { $seed = $seed.Replace($replacement.Key, (NsisString $replacement.Value)) }
  $seedFile = Join-Path $root 'seed.nsi'
  Set-Content -LiteralPath $seedFile -Value $seed -Encoding utf8
  Compile $seedFile
  RunInstaller $seedExe @('/S')
  Set-Content -LiteralPath (Join-Path $oldDir 'personal.keep') -Value 'unrelated user file'

  $script = Get-Content -LiteralPath $source -Raw
  $payloadMatch = [regex]::Match($script, '(?m)^!define MAINBINARYSRCPATH "([^"]+)"')
  Assert $payloadMatch.Success 'Generated NSIS payload path missing'
  $payload = Join-Path $root $newBinary
  Copy-Item -LiteralPath $payloadMatch.Groups[1].Value -Destination $payload
  $out = Join-Path $root 'upgrade.exe'
  $defines = @{
    PRODUCTNAME=$name; MAINBINARYNAME=$name; MAINBINARYSRCPATH=$payload; BUNDLEID="com.devport.smoke.$id";
    OUTFILE=$out; UNINSTKEY=$newKey; MANUKEY=$registryRoot; MANUPRODUCTKEY="$registryRoot\new-location"; INSTALLWEBVIEW2MODE='skip'
  }
  foreach ($define in $defines.GetEnumerator()) {
    $value = '!define ' + $define.Key + ' "' + (NsisString $define.Value) + '"'
    $script = [regex]::Replace($script, '(?m)^!define ' + $define.Key + ' "[^\r\n]+"', [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $value })
  }
  $prefix = @"
!addincludedir "$(NsisString $nsisDir)"
!define DEVPORT_LEGACY_UNINSTKEY "$(NsisString $oldKey)"
!define DEVPORT_LEGACY_INSTALLKEY "$(NsisString $oldInstallKey)"
!define DEVPORT_LEGACY_RUNNAME "$legacyName"
!define DEVPORT_LEGACY_BINARY "$oldBinary"
!define DEVPORT_LEGACY_SHORTCUT "$legacyName"
"@
  $upgradeFile = Join-Path $root 'upgrade.nsi'
  Set-Content -LiteralPath $upgradeFile -Value ($prefix + "`n" + $script) -Encoding utf8
  Compile $upgradeFile
  RunInstaller $out @('/S', '/UPDATE', "/D=$newDir")
  Assert (Test-Path -LiteralPath (Join-Path $newDir $newBinary)) 'New binary missing'
  Assert (!(Test-Path -LiteralPath (Join-Path $oldDir $oldBinary))) 'Old binary retained'
  Assert (Test-Path -LiteralPath (Join-Path $oldDir 'personal.keep')) 'Unrelated old directory content was removed'
  Assert (Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$newKey") 'New install identity missing'
  Assert (!(Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$oldKey")) 'Old uninstall identity retained'
  Assert (!(Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$oldInstallKey")) 'Old install location retained'
  $newRun = Get-ItemPropertyValue -LiteralPath $runKey -Name $name
  Assert ($newRun -eq "`"$newDir\$newBinary`" --minimized") 'Autostart target was not migrated'
  Assert ($null -eq (Get-ItemProperty -LiteralPath $runKey).PSObject.Properties[$legacyName]) 'Old autostart retained'
  foreach ($directory in @($desktop, $programs)) {
    Assert (Test-Path -LiteralPath (Join-Path $directory "$name.lnk")) 'New shortcut missing'
    Assert (!(Test-Path -LiteralPath (Join-Path $directory "$legacyName.lnk"))) 'Old shortcut retained'
  }
  RunInstaller $out @('/S', '/UPDATE', "/D=$newDir")
  Assert ((Get-ItemPropertyValue -LiteralPath $runKey -Name $name) -eq $newRun) 'Repeat installation changed autostart'
  RunInstaller (Join-Path $newDir 'uninstall.exe') @('/S')
  Assert (!(Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$newKey")) 'Uninstall left new identity'
  Set-Content -LiteralPath (Join-Path $root 'result.txt') -Value 'PASS: isolated legacy upgrade, identity, binary, autostart, shortcuts, repeated install and uninstall'
  Write-Output "PASS: installer migration ($root)"
} finally {
  # Only UUID-namespaced test keys and links are removed. Preserve files for audit.
  $cleanupKey = "Registry::HKEY_CURRENT_USER\$registryRoot"
  Assert ($registryRoot -match '^Software\\DevPortInstallerTests\\[a-f0-9]{32}$') 'Unsafe test registry cleanup target'
  Remove-Item -LiteralPath $cleanupKey -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($value in @($name, $legacyName)) {
    Remove-ItemProperty -LiteralPath $runKey -Name $value -ErrorAction SilentlyContinue
    foreach ($directory in @($desktop, $programs)) { Remove-Item -LiteralPath (Join-Path $directory "$value.lnk") -Force -ErrorAction SilentlyContinue }
  }
}
