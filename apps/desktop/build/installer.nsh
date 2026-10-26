; First-run milestones from the Windows installer: one GET when
; a fresh, interactive install starts and one when its files are in place, with
; the same install id the app reports under (services/debug-sync/device-id.ts).
; No content or account. Never blocks or fails the install: offline, it is lost.
; ABACUSAI_BOT_NO_FUNNEL=1 turns it off; ABACUSAI_BOT_ABACUS_HOST (an origin)
; points it elsewhere, which is how CI captures it.

!ifndef BUILD_UNINSTALLER

Var abacusInstallId
Var abacusBeaconHost
Var abacusBeaconArch
Var abacusBeaconStatus
Var abacusBaseDir

!define ABACUS_BEACON_PATH "/api/v1/_abacusaibotFunnelStep"
; Cloudflare refuses some non-browser agents; the app sends Chromium's too.
!define ABACUS_BEACON_AGENT "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

; A uuid the app or this installer wrote; anything else is left to the app.
!macro abacusCheckInstallId
  StrLen $abacusBeaconStatus $abacusInstallId
  ${If} $abacusBeaconStatus != 36
    StrCpy $abacusInstallId ""
  ${Else}
    StrCpy $abacusBeaconStatus $abacusInstallId 1 8
    ${If} $abacusBeaconStatus != "-"
      StrCpy $abacusInstallId ""
    ${EndIf}
  ${EndIf}
!macroend

!macro abacusBeacon STEP
  ${If} $abacusInstallId != ""
    inetc::get /SILENT /CONNECTTIMEOUT 5 /RECEIVETIMEOUT 5 /USERAGENT "${ABACUS_BEACON_AGENT}" \
      "$abacusBeaconHost${ABACUS_BEACON_PATH}?step=${STEP}&install=$abacusInstallId&v=${VERSION}&os=win32&arch=$abacusBeaconArch&build=installer" \
      "$PLUGINSDIR\funnel-beacon" /END
    ; "OK", or the reason it failed (the server answers 404 by design).
    Pop $abacusBeaconStatus
  ${EndIf}
!macroend

!macro customInit
  StrCpy $abacusInstallId ""
  ReadEnvStr $abacusBeaconStatus ABACUSAI_BOT_NO_FUNNEL
  ; An update runs silently and was counted when it was first installed.
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
  ${AndIf} $abacusBeaconStatus != "1"
    InitPluginsDir

    ReadEnvStr $abacusBeaconHost ABACUSAI_BOT_ABACUS_HOST
    ${If} $abacusBeaconHost == ""
      StrCpy $abacusBeaconHost "https://apps.abacus.ai"
    ${EndIf}
    StrCpy $abacusBeaconStatus $abacusBeaconHost 1 -1
    ${If} $abacusBeaconStatus == "/"
      StrCpy $abacusBeaconHost $abacusBeaconHost -1
    ${EndIf}

    ; The architecture the app installs as: an installer with both packages
    ; picks arm64 on an arm64 machine, as electron-builder does.
    StrCpy $abacusBeaconArch "x64"
    !ifdef APP_ARM64
      !ifdef APP_64
        ${If} ${IsNativeARM64}
          StrCpy $abacusBeaconArch "arm64"
        ${EndIf}
      !else
        StrCpy $abacusBeaconArch "arm64"
      !endif
    !endif

    ; profileBaseDir() in main/profile-home.ts.
    ReadEnvStr $abacusBaseDir ABACUSAI_BOT_BASE
    ${If} $abacusBaseDir == ""
      ReadEnvStr $abacusBaseDir ABACUSAI_BOT_HOME
    ${EndIf}
    ${If} $abacusBaseDir == ""
      StrCpy $abacusBaseDir "$PROFILE\.abacusai-bot"
    ${EndIf}

    ClearErrors
    FileOpen $abacusBeaconStatus "$abacusBaseDir\device-id" r
    ${IfNot} ${Errors}
      FileRead $abacusBeaconStatus $abacusInstallId
      FileClose $abacusBeaconStatus
    ${EndIf}
    ; The app trims; FileRead keeps a line ending.
    ${Do}
      StrCpy $abacusBeaconStatus $abacusInstallId 1 -1
      ${If} $abacusBeaconStatus == "$\n"
      ${OrIf} $abacusBeaconStatus == "$\r"
      ${OrIf} $abacusBeaconStatus == " "
        StrCpy $abacusInstallId $abacusInstallId -1
      ${Else}
        ${Break}
      ${EndIf}
    ${Loop}

    ${If} $abacusInstallId == ""
      Push $0
      System::Call 'ole32::CoCreateGuid(g .r0)'
      System::Call 'user32::CharLowerW(w r0 r0)'
      ; {xxxxxxxx-...}: crypto.randomUUID()'s shape without the braces.
      StrCpy $abacusInstallId $0 36 1
      Pop $0
      !insertmacro abacusCheckInstallId
      ${If} $abacusInstallId != ""
        CreateDirectory "$abacusBaseDir"
        ClearErrors
        FileOpen $abacusBeaconStatus "$abacusBaseDir\device-id" w
        ${If} ${Errors}
          ; Unsaved, the app would mint another and the two would never meet.
          StrCpy $abacusInstallId ""
        ${Else}
          FileWrite $abacusBeaconStatus $abacusInstallId
          FileClose $abacusBeaconStatus
        ${EndIf}
      ${EndIf}
    ${Else}
      !insertmacro abacusCheckInstallId
    ${EndIf}

    !insertmacro abacusBeacon "installer_start"
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro abacusBeacon "installer_done"
!macroend

!endif
