; Custom NSIS install/uninstall hooks.
; Creates the desktop shortcut with explicit icon so it always shows correctly.
; electron-builder's built-in createDesktopShortcut is disabled in package.json
; to avoid duplicate or icon-less shortcuts.

!macro customInstall
    CreateShortcut "$DESKTOP\BotW Live Savegame Monitor.lnk" "$INSTDIR\botw-ls-monitor.exe" "" "$INSTDIR\botw-ls-monitor.exe" 0
!macroend

!macro customUnInstall
    Delete "$DESKTOP\BotW Live Savegame Monitor.lnk"
!macroend
