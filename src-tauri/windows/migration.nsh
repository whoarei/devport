; One-time transition from the published current-user Remote Runner NSIS channel.
; Defaults may be overridden by the isolated installer smoke test only.
!ifndef DEVPORT_LEGACY_UNINSTKEY
!define DEVPORT_LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Remote Runner"
!endif
!ifndef DEVPORT_LEGACY_INSTALLKEY
!define DEVPORT_LEGACY_INSTALLKEY "Software\devrunner\Remote Runner"
!endif
!ifndef DEVPORT_LEGACY_RUNNAME
!define DEVPORT_LEGACY_RUNNAME "Remote Runner"
!endif

!ifndef DEVPORT_LEGACY_BINARY
!define DEVPORT_LEGACY_BINARY "remote-runner.exe"
!endif
!ifndef DEVPORT_LEGACY_SHORTCUT
!define DEVPORT_LEGACY_SHORTCUT "Remote Runner"
!endif

Var LegacyInstallDir
Var LegacyAutostart
Var LegacyMigrated

!macro DevPortMigrateShortcut DIRECTORY
  !insertmacro IsShortcutTarget "${DIRECTORY}\${DEVPORT_LEGACY_SHORTCUT}.lnk" "$LegacyInstallDir\${DEVPORT_LEGACY_BINARY}"
  Pop $0
  ${If} $0 = 1
    ${IfNot} ${FileExists} "${DIRECTORY}\${PRODUCTNAME}.lnk"
      ClearErrors
      CreateShortcut "${DIRECTORY}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      ${IfNot} ${Errors}
        !insertmacro SetLnkAppUserModelId "${DIRECTORY}\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}
    !insertmacro IsShortcutTarget "${DIRECTORY}\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "${DIRECTORY}\${DEVPORT_LEGACY_SHORTCUT}.lnk"
      Delete "${DIRECTORY}\${DEVPORT_LEGACY_SHORTCUT}.lnk"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $LegacyMigrated 0
  StrCpy $LegacyAutostart 0
  ReadRegStr $LegacyInstallDir HKCU "${DEVPORT_LEGACY_INSTALLKEY}" ""
  ReadRegStr $0 HKCU "${DEVPORT_LEGACY_UNINSTKEY}" "InstallLocation"
  ReadRegStr $1 HKCU "${DEVPORT_LEGACY_UNINSTKEY}" "UninstallString"
  ReadRegStr $2 HKCU "${DEVPORT_LEGACY_UNINSTKEY}" "MainBinaryName"
  ${If} $LegacyInstallDir != ""
  ${AndIf} $0 == '$\"$LegacyInstallDir$\"'
  ${AndIf} $1 == '$\"$LegacyInstallDir\uninstall.exe$\"'
  ${AndIf} $2 == "${DEVPORT_LEGACY_BINARY}"
  ${AndIf} ${FileExists} "$LegacyInstallDir\${DEVPORT_LEGACY_BINARY}"
  ${AndIf} ${FileExists} "$LegacyInstallDir\uninstall.exe"
    !insertmacro CheckIfAppIsRunning "${DEVPORT_LEGACY_BINARY}" "Remote Runner"
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${DEVPORT_LEGACY_RUNNAME}"
    ${If} $0 == '$\"$LegacyInstallDir\${DEVPORT_LEGACY_BINARY}$\" --minimized'
    ${OrIf} $0 == "$LegacyInstallDir\${DEVPORT_LEGACY_BINARY} --minimized"
      StrCpy $LegacyAutostart 1
    ${EndIf}
    ; /UPDATE preserves application data and leaves shortcuts/autostart for us.
    ExecWait '$\"$LegacyInstallDir\uninstall.exe$\" /S /UPDATE _?=$LegacyInstallDir' $0
    ${If} $0 != 0
    ${OrIf} ${FileExists} "$LegacyInstallDir\${DEVPORT_LEGACY_BINARY}"
      Abort "Could not migrate Remote Runner. Original application data is retained."
    ${EndIf}
    StrCpy $LegacyMigrated 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $LegacyMigrated = 1
    !insertmacro DevPortMigrateShortcut "$SMPROGRAMS"
    !insertmacro DevPortMigrateShortcut "$DESKTOP"
    ${If} $LegacyAutostart = 1
      ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
      ${If} $0 == ""
        WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --minimized'
      ${EndIf}
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${DEVPORT_LEGACY_RUNNAME}"
    ${EndIf}
    DeleteRegKey HKCU "${DEVPORT_LEGACY_UNINSTKEY}"
    DeleteRegKey HKCU "${DEVPORT_LEGACY_INSTALLKEY}"
    ${If} $LegacyInstallDir != $INSTDIR
      ; Remove only the known uninstaller and an empty old install directory.
      Delete "$LegacyInstallDir\uninstall.exe"
      RMDir "$LegacyInstallDir"
    ${EndIf}
  ${EndIf}
!macroend
