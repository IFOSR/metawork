; NSIS owns first installation and extraction only. Existing installations go
; through the Desktop impact confirmation and the common activation helper.
!ifdef BUILD_UNINSTALLER
  Var mwUninstallApproved
!endif

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    Function un.MetaWorkConfirm
      ${If} $mwUninstallApproved == "true"
        Return
      ${EndIf}
      InitPluginsDir
      StrCpy $R0 ""
      ${If} ${Silent}
        StrCpy $R0 "--metawork-uninstall-silent"
      ${EndIf}
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--metawork-uninstall=$PLUGINSDIR\metawork-uninstall-result" $R0'
      ${If} ${Errors}
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $R2 0
      ${Do}
        ${If} ${FileExists} "$PLUGINSDIR\metawork-uninstall-result"
          ${ExitDo}
        ${EndIf}
        Sleep 250
        IntOp $R2 $R2 + 1
      ${LoopUntil} $R2 >= 1200
      ClearErrors
      FileOpen $R0 "$PLUGINSDIR\metawork-uninstall-result" r
      ${If} ${Errors}
        SetErrorLevel 2
        Quit
      ${EndIf}
      FileRead $R0 $R1
      FileRead $R0 $R2
      FileClose $R0
      ${If} $R1 != "approved$\r$\n"
      ${OrIf} $R2 <= 0
        SetErrorLevel 2
        Quit
      ${EndIf}
      ; Wait for the approved Main process. Never force-kill the application or
      ; an independent Server; failed drain or client exit prevents removal.
      System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i R2) p.R3 ?e'
      Pop $R4
      ${If} $R3 != 0
        System::Call 'kernel32::WaitForSingleObject(p R3, i 30000) i.R4'
        System::Call 'kernel32::CloseHandle(p R3)'
        ${If} $R4 != 0
          SetErrorLevel 2
          Quit
        ${EndIf}
      ${ElseIf} $R4 != 87
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $mwUninstallApproved "true"
    FunctionEnd
  !endif
!macroend

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.MetaWorkConfirm
  !else
    ; The registered-installation branch already handed off in customInit.
    ; Refuse an unregistered occupied destination instead of overwriting it.
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      MessageBox MB_OK|MB_ICONEXCLAMATION "Open MetaWork and use Install Update before replacing this installation." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  !endif
!macroend

!macro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/metawork-stage=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 == ""
      SetErrorLevel 2
      Quit
    ${EndIf}
    IfFileExists "$R1" stageRefused 0
    CreateDirectory "$R1"
    IfErrors stageRefused 0
    InitPluginsDir
    File /oname=$PLUGINSDIR\metawork-app.7z "${APP_64}"
    SetOutPath "$R1"
    Nsis7z::Extract "$PLUGINSDIR\metawork-app.7z"
    IfFileExists "$R1\MetaWork.exe" 0 stageRefused
    File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
    SetErrorLevel 0
    Quit
    stageRefused:
      SetErrorLevel 2
      Quit
  ${EndIf}
  ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R1 != ""
  ${AndIf} ${FileExists} "$R1\${APP_EXECUTABLE_FILENAME}"
    Exec '"$R1\${APP_EXECUTABLE_FILENAME}" "--metawork-install-update=$EXEPATH"'
    IfErrors 0 +3
      SetErrorLevel 2
      Quit
    SetErrorLevel 0
    Quit
  ${EndIf}
!macroend
