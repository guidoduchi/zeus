from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

from .application.service import ApplicationService
from .config import application_home, default_data_dir, ensure_config
from .diagnostics import diagnostic_log_path, record_exception
from .store import ZeusStore
from .storage_migration import finalize_pending_data_migration
from .utils import json_dumps
from .version import __version__
from .web.dialogs import open_folder
from .web.runtime import InstanceRegistry, new_instance_id
from .web.server import ZeusWebServer
from .web.tray import TrayController


LEGACY_COMMANDS = {
    "startup",
    "dashboard",
    "list",
    "show",
    "paths",
    "settings",
    "sync-advanced",
    "publish",
    "mail",
    "restore-pendings",
    "doctor",
    "mop",
}


def create_store() -> ZeusStore:
    home = application_home()
    config = ensure_config(home)
    if os.environ.get("ZEUS_DATA_DIR"):
        root = default_data_dir(home)
        storage_notices: list[str] = []
    else:
        root, storage_notices = finalize_pending_data_migration(home, config)
    store = ZeusStore(root, config_home=home)
    store.storage_notices = storage_notices
    store.ensure_layout()
    return store


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="zeus",
        description="Zeus 3 local web ticket workstation",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command")
    serve = sub.add_parser("serve", help="start the local Zeus web application")
    serve.add_argument("--port", type=int)
    serve.add_argument("--no-browser", action="store_true")
    serve.add_argument("--no-tray", action="store_true")
    serve.add_argument("--console", action="store_true")
    stop = sub.add_parser("stop", help="stop all registered Zeus instances")
    stop.add_argument("--no-force", action="store_true")
    return parser


def _start_server_on_available_port(
    service: ApplicationService,
    *,
    preferred_port: int,
    static_root: Path,
    instance_id: str,
) -> ZeusWebServer:
    candidates = list(range(preferred_port, min(65535, preferred_port + 20) + 1))
    candidates.append(0)
    last_error: OSError | None = None
    for port in candidates:
        try:
            return ZeusWebServer(
                ("127.0.0.1", port),
                service,
                static_root=static_root,
                instance_id=instance_id,
            )
        except OSError as exc:
            last_error = exc
    raise OSError("Zeus could not reserve a local port") from last_error


def _open_url(url: str) -> None:
    webbrowser.open_new_tab(url)


def _restart_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "serve"]
    return [sys.executable, "-m", "zeus2", "serve"]


def serve(args: argparse.Namespace) -> int:
    store = create_store()
    registry = InstanceRegistry(store.config_home)
    install_root = Path(__file__).resolve().parents[1]
    with registry.launch_guard():
        existing = registry.live_instances()
        if existing:
            url = str(existing[0]["url"])
            if not args.no_browser:
                _open_url(url)
            if args.console:
                print(f"Zeus is already running at {url}")
            return 0

        service = ApplicationService(store)
        preferred = int(args.port or store.config.get("web", {}).get("port", 8765))
        if not 1024 <= preferred <= 65535:
            raise ValueError("The Zeus port must be between 1024 and 65535")
        instance_id = new_instance_id()
        static_root = Path(__file__).resolve().parent / "web" / "static"
        server = _start_server_on_available_port(
            service,
            preferred_port=preferred,
            static_root=static_root,
            instance_id=instance_id,
        )
        registry.register(
            instance_id=instance_id,
            port=server.server_port,
            control_token=server.control_token,
            install_root=install_root,
        )

    http_thread = threading.Thread(
        target=server.serve_forever,
        name="zeus-http-server",
        daemon=True,
    )
    tray: TrayController | None = None
    restart_requested = threading.Event()

    def clean_shutdown() -> None:
        service.stop()
        if tray is not None:
            tray.stop()

    server.shutdown_callback = clean_shutdown
    http_thread.start()
    service.start()
    url = server.url
    config = store.config.get("web", {})
    should_open = bool(config.get("open_browser", True)) and not args.no_browser
    if should_open:
        threading.Timer(0.25, _open_url, args=(url,)).start()

    def open_logs() -> None:
        log_path = diagnostic_log_path(store.config_home)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        open_folder(log_path.parent)

    def request_restart() -> None:
        restart_requested.set()
        server.request_shutdown()

    server.restart_callback = request_restart

    use_tray = (
        sys.platform == "win32"
        and bool(config.get("system_tray", True))
        and not args.no_tray
        and not args.console
    )
    if args.console:
        print(f"Zeus {__version__} is running at {url}")
        print("Press Ctrl+C to stop it, or run zeus_stop.bat from another window.")

    try:
        if use_tray:
            tray = TrayController(
                tooltip=f"Zeus {__version__} — {url}",
                on_open=lambda: _open_url(url),
                on_logs=open_logs,
                on_restart=request_restart,
                on_exit=server.request_shutdown,
            )
            try:
                tray.run()
            except Exception as exc:
                record_exception(store.config_home, "ZEUS TRAY", exc)
                while http_thread.is_alive():
                    http_thread.join(timeout=0.5)
        else:
            while http_thread.is_alive():
                http_thread.join(timeout=0.5)
    except KeyboardInterrupt:
        server.request_shutdown()
        http_thread.join(timeout=10.0)
    finally:
        service.stop()
        registry.unregister(instance_id)
        server.server_close()

    if restart_requested.is_set():
        command = _restart_command()
        kwargs: dict[str, object] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = 0x00000008 | 0x00000200
            kwargs["close_fds"] = True
        subprocess.Popen(command, **kwargs)
    return 0


def stop_all(args: argparse.Namespace) -> int:
    home = application_home()
    registry = InstanceRegistry(home)
    results = registry.stop_all(force=not args.no_force)
    print(json_dumps({"instances": results}))
    return 0 if all(result.get("stopped") for result in results) else 1


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] in LEGACY_COMMANDS:
        from .cli import main as legacy_main

        return legacy_main(arguments)
    parser = build_parser()
    args = parser.parse_args(arguments)
    if args.command is None:
        args = parser.parse_args(["serve"])
    try:
        if args.command == "serve":
            return serve(args)
        if args.command == "stop":
            return stop_all(args)
        parser.error(f"Unknown command: {args.command}")
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        home = application_home()
        log_path = record_exception(home, f"command: {args.command}", exc)
        print(f"ERROR: {exc}", file=sys.stderr)
        if log_path:
            print(f"Diagnostic log: {log_path}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
