#!/usr/bin/env python3
"""
Configurable client-profile loader for Optimus Invoice.

Purpose
-------
Replaces the hard-coded Ferryscanner identity (CLIENT_VAT, recipient name
fallbacks, recipient address fallbacks, skip-issuer heuristics) in
vlm_invoice_parser.py with a JSON-driven profile. Each deployment of Optimus
Invoice runs for ONE receiving client (the operator) — METRO, Ferryscanner,
or whoever — and the profile tells the parser what THIS client looks like.

Without a profile loaded, the parser falls back to fully generic extraction
(no client-specific name/address regex). That is safer than ANY hardcoded
default because it avoids false-positive matches on the wrong tenant's docs.

Profile format
--------------
JSON file with the following shape (all keys optional):

    {
      "clientName":            "METRO AEBE",
      "clientVats":            ["EL094325446"],
      "clientNamePatterns":    ["METRO\\s*AEBE", "ΜΕΤΡΟ\\s*ΑΕΒΕ"],
      "clientAddressPatterns": ["Σώρου\\s+\\d+", "Sorou\\s+\\d+"],
      "skipIssuerPatterns":    ["METRO", "ΜΕΤΡΟ"],
      "managerPatterns":       []
    }

Loading order
-------------
1. Path from environment variable OPTIMUS_CLIENT_PROFILE
2. Otherwise: /app/data/client_profiles/active.json   (Docker container path)
3. Otherwise: ./data/client_profiles/active.json      (dev / repo-root path)
4. Otherwise: empty profile (no client-specific matching)

Hot reload
----------
The profile file's mtime is recorded at load time. Every call to
get_client_profile() does a cheap os.path.getmtime() check; if the mtime
has changed (because the UI wrote a new profile via the clientProfileRouter
tRPC endpoint), the singleton is reloaded in place — no container restart
needed. This means a save in the UI is visible to the next invoice extraction
within milliseconds.

Usage
-----
    from client_profile import get_client_profile

    profile = get_client_profile()

    if profile.is_client_vat(vat_extracted):
        # vat belongs to THIS deployment's receiver — treat as recipient
        ...

    if profile.should_skip_as_issuer(line):
        # this line looks like the client name, do not treat as issuer
        continue

    name  = profile.match_name(text)
    addr  = profile.match_address(text)
"""

import os
import re
import json
import logging
from typing import List, Pattern, Optional, Dict, Any

log = logging.getLogger(__name__)

_ENV_VAR = "OPTIMUS_CLIENT_PROFILE"
_DEFAULT_PATHS = [
    "/app/data/client_profiles/active.json",
    "./data/client_profiles/active.json",
]


class ClientProfile:
    """Loaded once per process; used by parsers to recognise the receiver.

    Auto-reloads from disk when the source file's mtime changes (so that
    edits made via the UI's clientProfile.upsert tRPC mutation become live
    without a container restart).
    """

    def __init__(self, profile_path: Optional[str] = None):
        self._path: Optional[str] = profile_path or os.environ.get(_ENV_VAR)
        if not self._path:
            for candidate in _DEFAULT_PATHS:
                if os.path.isfile(candidate):
                    self._path = candidate
                    break

        self._data: Dict[str, Any] = {}
        self._compiled_name: List[Pattern] = []
        self._compiled_address: List[Pattern] = []
        self._compiled_skip: List[Pattern] = []
        self._compiled_manager: List[Pattern] = []
        # mtime of the source file at the moment we loaded it. None means
        # "no file was loaded" — used by _check_reload() to detect changes.
        self._mtime: Optional[float] = None
        self._load()

    # ── Internal ──────────────────────────────────────────────────────

    def _load(self) -> None:
        if not self._path or not os.path.isfile(self._path):
            log.info(
                "[ClientProfile] No profile found (env=%s, defaults=%s) — "
                "running in generic mode with no client-specific fallbacks.",
                os.environ.get(_ENV_VAR), _DEFAULT_PATHS,
            )
            self._data = {}
            self._compiled_name = []
            self._compiled_address = []
            self._compiled_skip = []
            self._compiled_manager = []
            self._mtime = None
            return
        try:
            with open(self._path, encoding="utf-8") as f:
                self._data = json.load(f)
            log.info(
                "[ClientProfile] Loaded profile '%s' from %s",
                self._data.get("clientName", "<unnamed>"), self._path,
            )
        except Exception as e:
            log.warning("[ClientProfile] Failed to load %s: %s — running empty", self._path, e)
            self._data = {}
            self._mtime = None
            return

        self._compiled_name = self._compile(self._data.get("clientNamePatterns", []))
        self._compiled_address = self._compile(self._data.get("clientAddressPatterns", []))
        self._compiled_skip = self._compile(self._data.get("skipIssuerPatterns", []))
        self._compiled_manager = self._compile(self._data.get("managerPatterns", []))

        # Record mtime AFTER successful load so a subsequent failed reload
        # doesn't poison the cached mtime.
        try:
            self._mtime = os.path.getmtime(self._path)
        except OSError:
            self._mtime = None

    def _check_reload(self) -> None:
        """Re-read the profile if its source file has changed on disk.

        Called from get_client_profile() on every access. The cost is a
        single os.stat() syscall (~microseconds), which is negligible
        compared to the rest of an invoice extraction. The pay-off is
        zero-restart UI edits.
        """
        if not self._path:
            return
        try:
            current_mtime = (
                os.path.getmtime(self._path)
                if os.path.isfile(self._path)
                else None
            )
        except OSError:
            return
        if current_mtime != self._mtime:
            log.info(
                "[ClientProfile] mtime changed (%s -> %s) -- reloading from %s",
                self._mtime, current_mtime, self._path,
            )
            self._load()

    @staticmethod
    def _compile(patterns: List[str]) -> List[Pattern]:
        out: List[Pattern] = []
        for p in patterns:
            try:
                out.append(re.compile(p, re.IGNORECASE))
            except re.error as e:
                log.warning("[ClientProfile] Skipping invalid regex %r: %s", p, e)
        return out

    @staticmethod
    def _normalise_vat(vat: str) -> str:
        return (vat or "").replace(" ", "").upper().lstrip("EL")

    # ── Public API ────────────────────────────────────────────────────

    @property
    def name(self) -> Optional[str]:
        return self._data.get("clientName")

    @property
    def vats(self) -> List[str]:
        return list(self._data.get("clientVats", []))

    @property
    def loaded(self) -> bool:
        return bool(self._data)

    def is_client_vat(self, vat: str) -> bool:
        """True if the given VAT belongs to the receiving client."""
        if not vat:
            return False
        target = self._normalise_vat(vat)
        return any(self._normalise_vat(v) == target for v in self.vats)

    def match_name(self, text: str) -> Optional[str]:
        for pat in self._compiled_name:
            m = pat.search(text)
            if m:
                return m.group(0).strip()
        return None

    def match_address(self, text: str) -> Optional[str]:
        for pat in self._compiled_address:
            m = pat.search(text)
            if m:
                return m.group(0).strip()
        return None

    def should_skip_as_issuer(self, line: str) -> bool:
        """True if the line looks like the client — must not be the issuer."""
        for pat in self._compiled_skip:
            if pat.search(line):
                return True
        return False

    def manager_patterns(self) -> List[Pattern]:
        return list(self._compiled_manager)


# ── Singleton accessor ──────────────────────────────────────────────────────

_INSTANCE: Optional[ClientProfile] = None


def get_client_profile() -> ClientProfile:
    """Lazy-loaded singleton with mtime-based auto-reload.

    On first call: loads the profile from disk.
    On subsequent calls: checks if the source file's mtime has changed;
    if so, reloads in place. This makes UI saves (via the clientProfile
    tRPC mutation) visible to the next invoice extraction.
    """
    global _INSTANCE
    if _INSTANCE is None:
        _INSTANCE = ClientProfile()
    else:
        _INSTANCE._check_reload()
    return _INSTANCE


def reload_client_profile(path: Optional[str] = None) -> ClientProfile:
    """Force-reload the profile (useful for tests or after a config change).

    Note: with mtime auto-reload, this is rarely needed in normal operation
    — get_client_profile() picks up disk changes automatically. Keep around
    for tests that change OPTIMUS_CLIENT_PROFILE at runtime.
    """
    global _INSTANCE
    _INSTANCE = ClientProfile(profile_path=path)
    return _INSTANCE