# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = (
    collect_submodules("openpyxl")
    + collect_submodules("docx")
    + collect_submodules("win32com")
    + ["pythoncom", "pywintypes"]
)

a = Analysis(
    ["zeus_entry.py"],
    pathex=["."],
    binaries=[],
    datas=[("zeus2/web/static", "zeus2/web/static")],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="zeus",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
)
