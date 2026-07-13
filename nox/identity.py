"""Canonical Nox identity loading and session-bound prompt snapshots."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
import sysconfig
from typing import Any, Mapping

from hermes_cli.default_soul import DEFAULT_SOUL_MD, is_legacy_template_soul


ACCEPTED_NOX_IDENTITY_SHA256 = (
    "5d65771dfeec0ad50897fac123dfe4f358944d706edc5cc4fb9d7475b2f86a78"
)
_IDENTITY_RELATIVE_PATH = Path("identity") / "NOX.md"


class NoxIdentityError(RuntimeError):
    """Raised when the accepted identity cannot be loaded or verified."""


@dataclass(frozen=True)
class NoxIdentitySnapshot:
    """Exact identity prefix bound to one Hermes session."""

    revision: str
    prompt_sha256: str
    prompt_text: str

    @property
    def prompt_chars(self) -> int:
        return len(self.prompt_text)


def _sha256_text(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def _candidate_paths() -> tuple[Path, ...]:
    source_path = Path(__file__).resolve().parent.parent / _IDENTITY_RELATIVE_PATH
    candidates = [source_path]
    for scheme in ("data", "purelib", "platlib"):
        root = sysconfig.get_path(scheme)
        if root:
            candidates.append(Path(root) / _IDENTITY_RELATIVE_PATH)

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate.resolve(strict=False)).casefold()
        if key not in seen:
            unique.append(candidate)
            seen.add(key)
    return tuple(unique)


def load_nox_identity() -> NoxIdentitySnapshot:
    """Load the accepted document from a source checkout or installed wheel."""

    candidates = _candidate_paths()
    identity_path = next((path for path in candidates if path.is_file()), None)
    if identity_path is None:
        searched = ", ".join(str(path) for path in candidates)
        raise NoxIdentityError(f"Accepted Nox identity is missing; searched: {searched}")

    raw = identity_path.read_bytes()
    revision = sha256(raw).hexdigest()
    if revision != ACCEPTED_NOX_IDENTITY_SHA256:
        raise NoxIdentityError(
            "Nox identity revision mismatch: "
            f"expected {ACCEPTED_NOX_IDENTITY_SHA256}, got {revision} at {identity_path}"
        )
    try:
        prompt_text = raw.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise NoxIdentityError(f"Nox identity is not valid UTF-8: {identity_path}") from exc
    if not prompt_text:
        raise NoxIdentityError(f"Nox identity is empty: {identity_path}")

    return NoxIdentitySnapshot(
        revision=revision,
        prompt_sha256=_sha256_text(prompt_text),
        prompt_text=prompt_text,
    )


def bind_nox_identity(
    agent: Any,
    snapshot: NoxIdentitySnapshot | None = None,
) -> NoxIdentitySnapshot:
    """Bind one verified identity prefix to an agent for its session lifetime."""

    bound = snapshot or load_nox_identity()
    agent._nox_identity_snapshot = bound
    agent._preserve_system_prompt_snapshot = False
    return bound


def bound_nox_identity(agent: Any) -> NoxIdentitySnapshot:
    """Return the session-bound identity, binding the accepted revision if new."""

    snapshot = getattr(agent, "_nox_identity_snapshot", None)
    if isinstance(snapshot, NoxIdentitySnapshot):
        return snapshot
    return bind_nox_identity(agent)


def restore_nox_identity(
    agent: Any,
    session_row: Mapping[str, Any],
    stored_prompt: str,
) -> NoxIdentitySnapshot | None:
    """Recover and verify the identity prefix stored with a session prompt.

    Sessions created before Nox integration have no identity metadata. Their
    stored prompt remains authoritative and is preserved verbatim at compression
    boundaries instead of being silently upgraded.
    """

    revision = session_row.get("nox_identity_revision")
    prompt_chars = session_row.get("nox_identity_chars")
    prompt_hash = session_row.get("nox_identity_prompt_sha256")
    metadata = (revision, prompt_chars, prompt_hash)

    if all(value is None for value in metadata):
        current = load_nox_identity()
        if stored_prompt.startswith(current.prompt_text):
            return bind_nox_identity(agent, current)
        agent._nox_identity_snapshot = None
        agent._preserve_system_prompt_snapshot = True
        return None

    if any(value is None for value in metadata):
        raise NoxIdentityError("Stored Nox identity metadata is incomplete")
    if not isinstance(revision, str) or len(revision) != 64:
        raise NoxIdentityError("Stored Nox identity revision is invalid")
    if not isinstance(prompt_hash, str) or len(prompt_hash) != 64:
        raise NoxIdentityError("Stored Nox identity prompt hash is invalid")
    if not isinstance(prompt_chars, int) or prompt_chars <= 0:
        raise NoxIdentityError("Stored Nox identity prefix length is invalid")
    if prompt_chars > len(stored_prompt):
        raise NoxIdentityError("Stored Nox identity prefix exceeds the system prompt")

    prompt_text = stored_prompt[:prompt_chars]
    actual_hash = _sha256_text(prompt_text)
    if actual_hash != prompt_hash:
        raise NoxIdentityError(
            "Stored Nox identity prefix does not match its persisted prompt hash"
        )

    snapshot = NoxIdentitySnapshot(
        revision=revision,
        prompt_sha256=prompt_hash,
        prompt_text=prompt_text,
    )
    return bind_nox_identity(agent, snapshot)


def identity_persistence_fields(agent: Any) -> dict[str, str | int]:
    """Return the session columns that bind a prompt to its Nox revision."""

    snapshot = getattr(agent, "_nox_identity_snapshot", None)
    if not isinstance(snapshot, NoxIdentitySnapshot):
        return {}
    return {
        "nox_identity_revision": snapshot.revision,
        "nox_identity_chars": snapshot.prompt_chars,
        "nox_identity_prompt_sha256": snapshot.prompt_sha256,
    }


def profile_soul_block(content: str | None) -> str:
    """Render a customized SOUL.md as an additive profile for the same Nox."""

    if not content:
        return ""
    profile = content.strip()
    if not profile:
        return ""
    if profile == DEFAULT_SOUL_MD.strip() or is_legacy_template_soul(profile):
        return ""
    return (
        "## Current profile\n\n"
        "This profile contributes current preferences and context to the same Nox.\n\n"
        f"{profile}"
    )


__all__ = [
    "ACCEPTED_NOX_IDENTITY_SHA256",
    "NoxIdentityError",
    "NoxIdentitySnapshot",
    "bind_nox_identity",
    "bound_nox_identity",
    "identity_persistence_fields",
    "load_nox_identity",
    "profile_soul_block",
    "restore_nox_identity",
]
