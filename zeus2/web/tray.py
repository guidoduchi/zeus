from __future__ import annotations

import sys
import threading
from typing import Callable


class TrayController:
    """Pure-Windows notification-area controller with no runtime dependency."""

    def __init__(
        self,
        *,
        tooltip: str,
        on_open: Callable[[], None],
        on_logs: Callable[[], None],
        on_restart: Callable[[], None],
        on_exit: Callable[[], None],
    ):
        self.tooltip = tooltip
        self.on_open = on_open
        self.on_logs = on_logs
        self.on_restart = on_restart
        self.on_exit = on_exit
        self._stop_event = threading.Event()
        self._hwnd: int | None = None

    def run(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("The Zeus tray controller is available only on Windows")
        self._run_windows()

    def stop(self) -> None:
        self._stop_event.set()
        hwnd = self._hwnd
        if hwnd and sys.platform == "win32":
            try:
                import ctypes

                ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
            except Exception:
                pass

    @staticmethod
    def _async(callback: Callable[[], None]) -> None:
        threading.Thread(target=callback, name="zeus-tray-action", daemon=True).start()

    def _run_windows(self) -> None:
        import ctypes
        from ctypes import wintypes

        WM_DESTROY = 0x0002
        WM_CLOSE = 0x0010
        WM_USER = 0x0400
        WM_TRAY = WM_USER + 20
        WM_LBUTTONUP = 0x0202
        WM_LBUTTONDBLCLK = 0x0203
        WM_RBUTTONUP = 0x0205
        NIM_ADD = 0x00000000
        NIM_DELETE = 0x00000002
        NIF_MESSAGE = 0x00000001
        NIF_ICON = 0x00000002
        NIF_TIP = 0x00000004
        MF_STRING = 0x00000000
        MF_SEPARATOR = 0x00000800
        TPM_RIGHTBUTTON = 0x0002
        TPM_RETURNCMD = 0x0100
        TPM_NONOTIFY = 0x0080
        ID_OPEN = 1001
        ID_LOGS = 1002
        ID_RESTART = 1003
        ID_EXIT = 1004

        LRESULT = ctypes.c_ssize_t
        WNDPROC = ctypes.WINFUNCTYPE(
            LRESULT,
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        )

        class WNDCLASSW(ctypes.Structure):
            _fields_ = [
                ("style", wintypes.UINT),
                ("lpfnWndProc", WNDPROC),
                ("cbClsExtra", ctypes.c_int),
                ("cbWndExtra", ctypes.c_int),
                ("hInstance", wintypes.HINSTANCE),
                ("hIcon", wintypes.HICON),
                ("hCursor", wintypes.HANDLE),
                ("hbrBackground", wintypes.HBRUSH),
                ("lpszMenuName", wintypes.LPCWSTR),
                ("lpszClassName", wintypes.LPCWSTR),
            ]

        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        class NOTIFYICONDATAW(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("hWnd", wintypes.HWND),
                ("uID", wintypes.UINT),
                ("uFlags", wintypes.UINT),
                ("uCallbackMessage", wintypes.UINT),
                ("hIcon", wintypes.HICON),
                ("szTip", wintypes.WCHAR * 128),
                ("dwState", wintypes.DWORD),
                ("dwStateMask", wintypes.DWORD),
                ("szInfo", wintypes.WCHAR * 256),
                ("uTimeoutOrVersion", wintypes.UINT),
                ("szInfoTitle", wintypes.WCHAR * 64),
                ("dwInfoFlags", wintypes.DWORD),
                ("guidItem", GUID),
                ("hBalloonIcon", wintypes.HICON),
            ]

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        shell32 = ctypes.WinDLL("shell32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASSW)]
        user32.RegisterClassW.restype = wintypes.ATOM
        user32.UnregisterClassW.argtypes = [wintypes.LPCWSTR, wintypes.HINSTANCE]
        user32.UnregisterClassW.restype = wintypes.BOOL
        user32.CreateWindowExW.argtypes = [
            wintypes.DWORD,
            wintypes.LPCWSTR,
            wintypes.LPCWSTR,
            wintypes.DWORD,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.HWND,
            wintypes.HMENU,
            wintypes.HINSTANCE,
            wintypes.LPVOID,
        ]
        user32.CreateWindowExW.restype = wintypes.HWND
        user32.DestroyWindow.argtypes = [wintypes.HWND]
        user32.DestroyWindow.restype = wintypes.BOOL
        user32.DefWindowProcW.argtypes = [
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        ]
        user32.DefWindowProcW.restype = LRESULT
        user32.PostMessageW.argtypes = [
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
        ]
        user32.PostMessageW.restype = wintypes.BOOL
        user32.CreatePopupMenu.argtypes = []
        user32.CreatePopupMenu.restype = wintypes.HMENU
        user32.AppendMenuW.argtypes = [
            wintypes.HMENU,
            wintypes.UINT,
            ctypes.c_size_t,
            wintypes.LPCWSTR,
        ]
        user32.AppendMenuW.restype = wintypes.BOOL
        user32.DestroyMenu.argtypes = [wintypes.HMENU]
        user32.DestroyMenu.restype = wintypes.BOOL
        user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
        user32.GetCursorPos.restype = wintypes.BOOL
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        user32.SetForegroundWindow.restype = wintypes.BOOL
        user32.TrackPopupMenu.argtypes = [
            wintypes.HMENU,
            wintypes.UINT,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
            wintypes.HWND,
            wintypes.LPVOID,
        ]
        user32.TrackPopupMenu.restype = wintypes.UINT
        user32.LoadIconW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR]
        user32.LoadIconW.restype = wintypes.HICON
        user32.GetMessageW.argtypes = [
            ctypes.POINTER(wintypes.MSG),
            wintypes.HWND,
            wintypes.UINT,
            wintypes.UINT,
        ]
        user32.GetMessageW.restype = wintypes.BOOL
        user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        user32.TranslateMessage.restype = wintypes.BOOL
        user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        user32.DispatchMessageW.restype = LRESULT
        shell32.Shell_NotifyIconW.argtypes = [
            wintypes.DWORD,
            ctypes.POINTER(NOTIFYICONDATAW),
        ]
        shell32.Shell_NotifyIconW.restype = wintypes.BOOL
        kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        kernel32.GetModuleHandleW.restype = wintypes.HINSTANCE
        class_name = f"ZeusTrayWindow{abs(id(self))}"
        icon_data: NOTIFYICONDATAW | None = None

        def invoke(command: int) -> None:
            if command == ID_OPEN:
                self._async(self.on_open)
            elif command == ID_LOGS:
                self._async(self.on_logs)
            elif command == ID_RESTART:
                self._async(self.on_restart)
            elif command == ID_EXIT:
                self._async(self.on_exit)

        def show_menu(hwnd: int) -> None:
            menu = user32.CreatePopupMenu()
            if not menu:
                return
            try:
                user32.AppendMenuW(menu, MF_STRING, ID_OPEN, "Open Zeus")
                user32.AppendMenuW(menu, MF_STRING, ID_LOGS, "Open diagnostic logs")
                user32.AppendMenuW(menu, MF_STRING, ID_RESTART, "Restart Zeus")
                user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
                user32.AppendMenuW(menu, MF_STRING, ID_EXIT, "Exit Zeus")
                point = wintypes.POINT()
                user32.GetCursorPos(ctypes.byref(point))
                user32.SetForegroundWindow(hwnd)
                command = user32.TrackPopupMenu(
                    menu,
                    TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                    point.x,
                    point.y,
                    0,
                    hwnd,
                    None,
                )
                if command:
                    invoke(int(command))
            finally:
                user32.DestroyMenu(menu)

        @WNDPROC
        def window_proc(hwnd: int, message: int, wparam: int, lparam: int) -> int:
            if message == WM_TRAY:
                event = int(lparam) & 0xFFFF
                if event in {WM_LBUTTONUP, WM_LBUTTONDBLCLK}:
                    invoke(ID_OPEN)
                elif event == WM_RBUTTONUP:
                    show_menu(hwnd)
                return 0
            if message == WM_CLOSE:
                user32.DestroyWindow(hwnd)
                return 0
            if message == WM_DESTROY:
                user32.PostQuitMessage(0)
                return 0
            return user32.DefWindowProcW(hwnd, message, wparam, lparam)

        instance = kernel32.GetModuleHandleW(None)
        window_class = WNDCLASSW()
        window_class.lpfnWndProc = window_proc
        window_class.hInstance = instance
        window_class.lpszClassName = class_name
        if not user32.RegisterClassW(ctypes.byref(window_class)):
            raise OSError("Windows could not register the Zeus tray controller")
        hwnd = user32.CreateWindowExW(
            0,
            class_name,
            "Zeus",
            0,
            0,
            0,
            0,
            0,
            None,
            None,
            instance,
            None,
        )
        if not hwnd:
            user32.UnregisterClassW(class_name, instance)
            raise OSError("Windows could not create the Zeus tray controller")
        self._hwnd = int(hwnd)
        try:
            icon_resource = ctypes.cast(ctypes.c_void_p(32512), wintypes.LPCWSTR)
            icon = user32.LoadIconW(None, icon_resource)
            icon_data = NOTIFYICONDATAW()
            icon_data.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
            icon_data.hWnd = hwnd
            icon_data.uID = 1
            icon_data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
            icon_data.uCallbackMessage = WM_TRAY
            icon_data.hIcon = icon
            icon_data.szTip = self.tooltip[:127]
            if not shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(icon_data)):
                raise OSError("Windows could not add the Zeus tray icon")
            if self._stop_event.is_set():
                user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
            message = wintypes.MSG()
            while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(message))
                user32.DispatchMessageW(ctypes.byref(message))
        finally:
            if icon_data is not None:
                shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(icon_data))
            self._hwnd = None
            user32.DestroyWindow(hwnd)
            user32.UnregisterClassW(class_name, instance)
