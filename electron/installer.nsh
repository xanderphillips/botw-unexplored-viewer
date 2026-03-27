; Custom NSIS install/uninstall hooks.
; Creates desktop and Start Menu shortcuts with explicit icon so they always show correctly.
; electron-builder's built-in createDesktopShortcut and createStartMenuShortcut are disabled
; in package.json to avoid duplicate or icon-less shortcuts.

!macro customInstall
    IfFileExists "$DESKTOP\BotW Live Savegame Monitor.lnk" +2
    CreateShortcut "$DESKTOP\BotW Live Savegame Monitor.lnk" "$INSTDIR\botw-ls-monitor.exe" "" "$INSTDIR\botw-ls-monitor.exe" 0
    IfFileExists "$SMPROGRAMS\BotW Live Savegame Monitor.lnk" +2
    CreateShortcut "$SMPROGRAMS\BotW Live Savegame Monitor.lnk" "$INSTDIR\botw-ls-monitor.exe" "" "$INSTDIR\botw-ls-monitor.exe" 0
!macroend

!macro customUnInstall
    ${ifNot} ${isUpdated}
        Delete "$DESKTOP\BotW Live Savegame Monitor.lnk"
        Delete "$SMPROGRAMS\BotW Live Savegame Monitor.lnk"
    ${endIf}
!macroend
