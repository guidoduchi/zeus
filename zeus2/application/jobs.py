from __future__ import annotations

import threading
import traceback
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from queue import Queue
from typing import Any, Callable

from ..utils import iso_now


class JobCancelled(RuntimeError):
    """Raised cooperatively when a cancellable Zeus job is stopped."""


class EventBroker:
    """Small in-process event log used by Server-Sent Events clients."""

    def __init__(self, *, retained: int = 500):
        self._condition = threading.Condition()
        self._events: deque[dict[str, Any]] = deque(maxlen=retained)
        self._sequence = 0

    @property
    def sequence(self) -> int:
        with self._condition:
            return self._sequence

    def publish(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._condition:
            self._sequence += 1
            event = {
                "sequence": self._sequence,
                "type": event_type,
                "timestamp": iso_now(),
                "payload": payload,
            }
            self._events.append(event)
            self._condition.notify_all()
            return dict(event)

    def wait_after(self, sequence: int, *, timeout: float = 20.0) -> list[dict[str, Any]]:
        with self._condition:
            ready = [event for event in self._events if event["sequence"] > sequence]
            if ready:
                return [dict(event) for event in ready]
            self._condition.wait(timeout=max(0.0, timeout))
            return [
                dict(event) for event in self._events if event["sequence"] > sequence
            ]


@dataclass
class JobRecord:
    id: str
    kind: str
    label: str
    status: str = "queued"
    cancellable: bool = False
    created_at: str = field(default_factory=iso_now)
    started_at: str | None = None
    finished_at: str | None = None
    stage: str = "queued"
    message: str = "Waiting"
    current: int | None = None
    total: int | None = None
    result: dict[str, Any] | list[Any] | str | int | float | bool | None = None
    error: dict[str, Any] | None = None

    def snapshot(self) -> dict[str, Any]:
        value = asdict(self)
        return {
            "id": value["id"],
            "kind": value["kind"],
            "label": value["label"],
            "status": value["status"],
            "cancellable": value["cancellable"],
            "createdAt": value["created_at"],
            "startedAt": value["started_at"],
            "finishedAt": value["finished_at"],
            "stage": value["stage"],
            "message": value["message"],
            "current": value["current"],
            "total": value["total"],
            "result": value["result"],
            "error": value["error"],
        }


class JobContext:
    def __init__(self, manager: "JobManager", job_id: str, cancel_event: threading.Event):
        self._manager = manager
        self.job_id = job_id
        self.cancel_event = cancel_event

    def report(
        self,
        stage: str,
        message: str,
        *,
        current: int | None = None,
        total: int | None = None,
    ) -> None:
        self._manager._progress(
            self.job_id,
            stage=stage,
            message=message,
            current=current,
            total=total,
        )

    def progress_callback(self, event: dict[str, Any]) -> None:
        phase = str(event.get("phase") or "working")
        if phase == "folder":
            message = "Scanning Outlook folders"
        elif phase == "scan":
            message = "Reading Outlook messages"
        elif phase == "commit":
            message = "Committing email results"
        else:
            message = str(event.get("message") or phase.replace("_", " ").title())
        self.report(
            phase,
            message,
            current=_optional_int(event.get("index") or event.get("current")),
            total=_optional_int(event.get("count") or event.get("total")),
        )

    def raise_if_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise JobCancelled("The operation was cancelled")


def _optional_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


JobFunction = Callable[[JobContext], Any]


class JobManager:
    """Serialize long Zeus operations and expose durable progress snapshots."""

    def __init__(self, broker: EventBroker, *, retained: int = 100):
        self.broker = broker
        self.retained = retained
        self._lock = threading.RLock()
        self._queue: Queue[str | None] = Queue()
        self._jobs: dict[str, JobRecord] = {}
        self._order: deque[str] = deque()
        self._functions: dict[str, JobFunction] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._stopping = threading.Event()
        self._worker = threading.Thread(
            target=self._run,
            name="zeus-job-worker",
            daemon=True,
        )
        self._worker.start()

    def submit(
        self,
        kind: str,
        label: str,
        function: JobFunction,
        *,
        cancellable: bool = False,
        deduplicate: bool = True,
    ) -> dict[str, Any]:
        with self._lock:
            if self._stopping.is_set():
                raise RuntimeError("The Zeus job manager is stopping")
            if deduplicate:
                for job_id in reversed(self._order):
                    existing = self._jobs[job_id]
                    if existing.kind == kind and existing.status in {"queued", "running"}:
                        return existing.snapshot()
            job_id = uuid.uuid4().hex
            job = JobRecord(
                id=job_id,
                kind=kind,
                label=label,
                cancellable=cancellable,
            )
            self._jobs[job_id] = job
            self._order.append(job_id)
            self._functions[job_id] = function
            self._cancel_events[job_id] = threading.Event()
            self._trim_locked()
            snapshot = job.snapshot()
            self._queue.put(job_id)
        self.broker.publish("job", snapshot)
        return snapshot

    def _trim_locked(self) -> None:
        while len(self._order) > self.retained:
            oldest_id = self._order[0]
            oldest = self._jobs[oldest_id]
            if oldest.status in {"queued", "running"}:
                break
            self._order.popleft()
            self._jobs.pop(oldest_id, None)
            self._functions.pop(oldest_id, None)
            self._cancel_events.pop(oldest_id, None)

    def _progress(
        self,
        job_id: str,
        *,
        stage: str,
        message: str,
        current: int | None,
        total: int | None,
    ) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.stage = stage
            job.message = message
            job.current = current
            job.total = total
            snapshot = job.snapshot()
        self.broker.publish("job", snapshot)

    def _run(self) -> None:
        while True:
            job_id = self._queue.get()
            if job_id is None:
                self._queue.task_done()
                return
            with self._lock:
                job = self._jobs[job_id]
                function = self._functions[job_id]
                cancel_event = self._cancel_events[job_id]
                job.status = "running"
                job.started_at = iso_now()
                job.stage = "starting"
                job.message = "Starting"
                snapshot = job.snapshot()
            self.broker.publish("job", snapshot)
            context = JobContext(self, job_id, cancel_event)
            try:
                result = function(context)
                context.raise_if_cancelled()
            except JobCancelled as exc:
                with self._lock:
                    job.status = "cancelled"
                    job.stage = "cancelled"
                    job.message = str(exc)
                    job.finished_at = iso_now()
                    snapshot = job.snapshot()
            except Exception as exc:
                with self._lock:
                    job.status = "failed"
                    job.stage = "failed"
                    job.message = str(exc) or type(exc).__name__
                    job.error = {
                        "type": type(exc).__name__,
                        "message": str(exc),
                        "traceback": "".join(
                            traceback.format_exception_only(type(exc), exc)
                        ).strip(),
                    }
                    job.finished_at = iso_now()
                    snapshot = job.snapshot()
            else:
                with self._lock:
                    job.status = "succeeded"
                    job.stage = "complete"
                    job.message = "Complete"
                    job.result = result
                    job.finished_at = iso_now()
                    snapshot = job.snapshot()
            finally:
                with self._lock:
                    self._functions.pop(job_id, None)
                    self._trim_locked()
                self._queue.task_done()
            self.broker.publish("job", snapshot)

    def cancel(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            if not job.cancellable:
                raise ValueError("This operation cannot be cancelled safely")
            if job.status not in {"queued", "running"}:
                return job.snapshot()
            self._cancel_events[job_id].set()
            job.message = "Cancellation requested"
            snapshot = job.snapshot()
        self.broker.publish("job", snapshot)
        return snapshot

    def snapshots(self) -> list[dict[str, Any]]:
        with self._lock:
            return [self._jobs[job_id].snapshot() for job_id in reversed(self._order)]

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.snapshot() if job else None

    def busy(self) -> bool:
        with self._lock:
            return any(job.status in {"queued", "running"} for job in self._jobs.values())

    def stop(self, *, timeout: float = 5.0) -> None:
        if self._stopping.is_set():
            return
        self._stopping.set()
        with self._lock:
            for job_id, job in self._jobs.items():
                if job.cancellable and job.status in {"queued", "running"}:
                    self._cancel_events[job_id].set()
        self._queue.put(None)
        self._worker.join(timeout=max(0.0, timeout))
