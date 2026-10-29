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
$contextRoot = "$registryRoot\Classes"
$directoryMenu = "Registry::HKEY_CURRENT_USER\$contextRoot\Directory\shell\$name"
$backgroundMenu = "Registry::HKEY_CURRENT_USER\$contextRoot\Directory\Background\shell\$name"
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
function DefaultRegistryValue([string]$key) { return (Get-Item -LiteralPath $key).GetValue('') }
Add-Type -Path (Join-Path $PSScriptRoot 'directory-menu-probe.cs')
function BackgroundMenuVisible {
  $label = DefaultRegistryValue $backgroundMenu
  $entries = [DevPortDirectoryMenuProbe]::ReadBackground($root, "$contextRoot\Directory\Background")
  return $entries -contains $label
}
function AssertDirectoryMenus {
  Assert ((DefaultRegistryValue "$directoryMenu\command") -eq "`"$newDir\$newBinary`" --open-workspace `"%1\.`"") 'Directory command is not safely quoted'
  Assert ((DefaultRegistryValue "$backgroundMenu\command") -eq "`"$newDir\$newBinary`" --open-workspace `"%V\.`"") 'Background command is not safely quoted'
  foreach ($menu in @($directoryMenu, $backgroundMenu)) {
    Assert ((DefaultRegistryValue $menu) -in @('使用 DevPort 打开', 'Open with DevPort')) 'Directory menu label missing'
    Assert ((Get-ItemPropertyValue -LiteralPath $menu -Name Icon) -eq "`"$newDir\$newBinary`",0") 'Directory menu icon missing'
  }
  Assert ((Get-ItemPropertyValue -LiteralPath $directoryMenu -Name MultiSelectModel) -eq 'Single') 'Directory menu must select one workspace'
  Assert ((Get-Item -LiteralPath $backgroundMenu).GetValueNames() -notcontains 'MultiSelectModel') 'Background menu must allow zero selected items'
  Assert (BackgroundMenuVisible) 'Windows Shell hides the installed background menu'
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
!define DEVPORT_CONTEXT_ROOT "$(NsisString $contextRoot)"
!define DEVPORT_CONTEXT_VERB "$name"
"@
  $upgradeFile = Join-Path $root 'upgrade.nsi'
  Set-Content -LiteralPath $upgradeFile -Value ($prefix + "`n" + $script) -Encoding utf8
  Compile $upgradeFile
  RunInstaller $out @('/S', '/UPDATE', "/D=$newDir")
  Assert (Test-Path -LiteralPath (Join-Path $newDir $newBinary)) 'New binary missing'
  Assert (!(Test-Path -LiteralPath (Join-Path $oldDir $oldBinary))) 'Old binary retained'
  Assert (Test-Path -LiteralPath (Join-Path $oldDir 'personal.keep')) 'Unrelated old directory content was removed'
  Assert (Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$newKey") 'New install identity missing'
  AssertDirectoryMenus
  Assert (!(Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$oldKey")) 'Old uninstall identity retained'
  Assert (!(Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$oldInstallKey")) 'Old install location retained'
  $newRun = Get-ItemPropertyValue -LiteralPath $runKey -Name $name
  Assert ($newRun -eq "`"$newDir\$newBinary`" --minimized") 'Autostart target was not migrated'
  Assert ($null -eq (Get-ItemProperty -LiteralPath $runKey).PSObject.Properties[$legacyName]) 'Old autostart retained'
  foreach ($directory in @($desktop, $programs)) {
    Assert (Test-Path -LiteralPath (Join-Path $directory "$name.lnk")) 'New shortcut missing'
    Assert (!(Test-Path -LiteralPath (Join-Path $directory "$legacyName.lnk"))) 'Old shortcut retained'
  }
  # Reproduce 1.1.0's hidden background verb and require an upgrade to remove it.
  Set-ItemProperty -LiteralPath $backgroundMenu -Name MultiSelectModel -Value Single
  Assert (!(BackgroundMenuVisible)) 'Windows Shell probe must reproduce the hidden 1.1.0 background menu'
  RunInstaller $out @('/S', '/UPDATE', "/D=$newDir")
  Assert ((Get-ItemPropertyValue -LiteralPath $runKey -Name $name) -eq $newRun) 'Repeat installation changed autostart'
  AssertDirectoryMenus
  RunInstaller (Join-Path $newDir 'uninstall.exe') @('/S', '/UPDATE')
  Assert (!(Test-Path -LiteralPath $directoryMenu)) 'Update uninstall left directory menu'
  Assert (!(Test-Path -LiteralPath $backgroundMenu)) 'Update uninstall left background menu'
  RunInstaller $out @('/S', '/UPDATE', "/D=$newDir")
  AssertDirectoryMenus
  RunInstaller (Join-Path $newDir 'uninstall.exe') @('/S')
  Assert (!(Test-Path -LiteralPath $directoryMenu)) 'Uninstall left directory menu'
  Assert (!(Test-Path -LiteralPath $backgroundMenu)) 'Uninstall left background menu'
  # A different install can take over the same verb; the old uninstaller must retain it.
  RunInstaller $out @('/S', '/UPDATE', "/D=$newDir")
  $foreignCommand = '"C:\unrelated\other.exe" "%1"'
  Set-Item -LiteralPath "$directoryMenu\command" -Value $foreignCommand
  RunInstaller (Join-Path $newDir 'uninstall.exe') @('/S')
  Assert (!(Test-Path -LiteralPath "Registry::HKEY_CURRENT_USER\$newKey")) 'Uninstall left new identity'
  Assert ((DefaultRegistryValue "$directoryMenu\command") -eq $foreignCommand) 'Uninstall removed another installation menu'
  Assert (!(Test-Path -LiteralPath $backgroundMenu)) 'Uninstall left owned background menu'
  Set-Content -LiteralPath (Join-Path $root 'result.txt') -Value 'PASS: isolated legacy upgrade, identity, binary, autostart, shortcuts, directory menus, quoted commands, repeated install, update uninstall and menu ownership'
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
