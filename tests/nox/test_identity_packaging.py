"""Packaged-artifact proof for the canonical Nox identity."""

from __future__ import annotations

import glob
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import venv

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]


def _venv_python(root: Path) -> Path:
    scripts = "Scripts" if os.name == "nt" else "bin"
    executable = "python.exe" if os.name == "nt" else "python"
    return root / scripts / executable


def _build(out_dir: Path, artifact: str) -> Path:
    command = [
        "uv",
        "--no-config",
        "build",
        f"--{artifact}",
        "--out-dir",
        str(out_dir),
        ".",
    ]
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert result.returncode == 0, f"uv build failed:\n{result.stderr}"
    pattern = "*.whl" if artifact == "wheel" else "*.tar.gz"
    matches = glob.glob(str(out_dir / pattern))
    assert len(matches) == 1, f"expected one {artifact}, got {matches}"
    return Path(matches[0])


@pytest.mark.integration
def test_installed_wheel_loads_the_accepted_nox_identity(tmp_path):
    wheel = _build(tmp_path / "wheel", "wheel")
    environment = tmp_path / "venv"
    venv.create(environment, with_pip=True)
    python = _venv_python(environment)
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "-q",
            "--no-deps",
            "--force-reinstall",
            str(wheel),
        ],
        check=True,
        timeout=300,
    )
    probe = (
        "from nox.identity import ("
        "ACCEPTED_NOX_IDENTITY_SHA256, load_nox_identity);"
        "i=load_nox_identity();"
        "assert i.revision==ACCEPTED_NOX_IDENTITY_SHA256;"
        "assert i.prompt_text.startswith(\"# Nox\\n\\nI'm Nox:\");"
        "print(i.revision)"
    )
    clean_env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
    run = subprocess.run(
        [str(python), "-c", probe],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        env=clean_env,
        timeout=120,
    )
    assert run.returncode == 0, f"wheel identity probe failed:\n{run.stderr}"


@pytest.mark.integration
def test_sdist_contains_exactly_the_canonical_nox_identity(tmp_path):
    sdist = _build(tmp_path / "sdist", "sdist")
    with tarfile.open(sdist) as archive:
        matches = [
            member
            for member in archive.getmembers()
            if member.name.endswith("/identity/NOX.md")
        ]
        assert len(matches) == 1
        packaged = archive.extractfile(matches[0])
        assert packaged is not None
        assert packaged.read() == (REPO_ROOT / "identity" / "NOX.md").read_bytes()
