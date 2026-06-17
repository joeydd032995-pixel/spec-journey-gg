# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for H2H GG Analyzer
# Produces a single-file, windowless (no console) executable.
#
# Build:
#   pyinstaller ggba_gui.spec
# Output:
#   dist/H2H_GG_Analyzer.exe  (Windows)
#   dist/H2H_GG_Analyzer      (Linux / macOS)

a = Analysis(
    ["ggba_gui.py"],
    pathex=[],
    binaries=[],
    # Bundle ggba_h2hggl.py alongside ggba_gui.py inside the exe
    datas=[("ggba_h2hggl.py", ".")],
    hiddenimports=["ggba_h2hggl", "httpx", "httpx._config", "tkinter"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="H2H_GG_Analyzer",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,          # no terminal window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
