"""Select one loopback test port approved by the actual host OS; never retry a failed bind."""
import os
import platform
import socket
import subprocess


def owned_loopback_port():
    port = 0
    if os.environ.get('WSL_INTEROP') or 'microsoft' in platform.release().lower():
        # Docker Desktop publishes on Windows. A Linux bind alone cannot detect
        # Windows excluded ranges (the observed WSAEACCES startup failure).
        command = (
            '$taskListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0); '
            '$taskListener.Start(); try { $taskListener.LocalEndpoint.Port } '
            'finally { $taskListener.Stop() }'
        )
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15,
        )
        text = result.stdout.strip()
        if not text.isascii() or not text.isdecimal() or not 1 <= int(text) <= 65535:
            raise RuntimeError('Windows did not supply a valid owned loopback port.')
        port = int(text)
    # Also verify Linux/WSL availability. Docker owns the bind after this short
    # reservation ends; a concurrent conflict remains a visible failure.
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', port))
        return reservation.getsockname()[1]
