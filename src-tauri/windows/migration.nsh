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

; The smoke test redirects these entries away from Explorer's real menu.
!ifndef DEVPORT_CONTEXT_ROOT
!define DEVPORT_CONTEXT_ROOT "Software\Classes"
!endif
!ifndef DEVPORT_CONTEXT_VERB
!define DEVPORT_CONTEXT_VERB "DevPort"
!endif

!macro DevPortInstallDirectoryMenu DIRECTORY ARGUMENT
  WriteRegStr HKCU "${DEVPORT_CONTEXT_ROOT}\${DIRECTORY}\shell\${DEVPORT_CONTEXT_VERB}" "" "$3"
  WriteRegStr HKCU "${DEVPORT_CONTEXT_ROOT}\${DIRECTORY}\shell\${DEVPORT_CONTEXT_VERB}" "Icon" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0'
  !if "${DIRECTORY}" == "Directory"
    WriteRegStr HKCU "${DEVPORT_CONTEXT_ROOT}\${DIRECTORY}\shell\${DEVPORT_CONTEXT_VERB}" "MultiSelectModel" "Single"
  !else
    ; A background menu has zero selected items: Single hides the verb entirely.
    ; Delete the value too, so upgrades repair the registration written by 1.1.0.
    DeleteRegValue HKCU "${DEVPORT_CONTEXT_ROOT}\${DIRECTORY}\shell\${DEVPORT_CONTEXT_VERB}" "MultiSelectModel"
  !endif
  ; The dot keeps a drive root's trailing backslash from escaping its closing quote.
  WriteRegStr HKCU "${DEVPORT_CONTEXT_ROOT}\${DIRECTORY}\shell\${DEVPORT_CONTEXT_VERB}\command" "" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open-workspace $\"${ARGUMENT}\.$\"'
!macroend

!macro DevPortRemoveDirectoryMenu DIRECTORY ARGUMENT
  ReadRegStr $0 HKCU "${DEVPORT_CONTEXT_ROOT}\${DIRECTORY}\shell\${DEVPORT_CONTEXT_VERB}\command" ""
  ${If} $0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --open-workspace $\"${ARGUMENT}\.$\"'
    DeleteRegKey HKCU "${DEVPORT_CONTEXT_ROOT}\${DIRECTORY}\shell\${DEVPORT_CONTEXT_VERB}"
  ${EndIf}
!macroend

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
  StrCpy $3 "Open with DevPort"
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $0 $0 & 0x3ff
  ${If} $0 = 4
    StrCpy $3 "使用 DevPort 打开"
  ${EndIf}
  !insertmacro DevPortInstallDirectoryMenu "Directory" "%1"
  !insertmacro DevPortInstallDirectoryMenu "Directory\Background" "%V"
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

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro DevPortRemoveDirectoryMenu "Directory" "%1"
  !insertmacro DevPortRemoveDirectoryMenu "Directory\Background" "%V"
!macroend
