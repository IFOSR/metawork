; NSIS owns first installation and extraction only. Existing installations go
; through the Desktop impact confirmation and the common activation helper.
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
