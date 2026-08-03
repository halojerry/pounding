; NSIS include for the POUNDING installer (wired via electron-builder nsis.include).
;
; The installer payload is ~324MB (lzma-compressed) and unpacks ~800MB — on
; slower disks / Defender-scanning machines the built-in progress bar can sit
; still for minutes while the biggest files are written. These hooks make the
; detail page explain what is happening so it no longer reads as "stuck".

!macro customInit
  ; Keep the details pane visible with per-file names so extraction progress is
  ; honest instead of a frozen percentage.
  SetDetailsPrint both
!macroend

!macro customInstall
  SetDetailsPrint both
  DetailPrint "POUNDING is extracting bundled runtimes (poundingcore, Python, managed CLIs)..."
  DetailPrint "POUNDING: this can take a few minutes on slower disks with real-time antivirus scanning."
  SetDetailsPrint both
!macroend

!macro customUnInstall
  DetailPrint "POUNDING: removing application data..."
!macroend
