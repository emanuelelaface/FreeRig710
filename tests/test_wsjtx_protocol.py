from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as directory:
    executable = Path(directory) / "wsjtx_protocol_vectors"
    subprocess.run([
        "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-I", str(root / "components/web_api"),
        str(root / "components/web_api/wsjtx_protocol.c"),
        str(root / "tests/wsjtx_protocol_vectors.c"),
        "-o", str(executable),
    ], check=True)
    result = subprocess.run([str(executable)], check=True, text=True, capture_output=True)
    assert result.stdout.strip() == "WSJT-X protocol vectors: OK"

udp = (root / "components/web_api/wsjtx_udp.c").read_text()
assert "sendto(s_socket" in udp
assert "recvfrom(s_socket" in udp
assert "connect(fd" not in udp
assert "WSJTX_MESSAGE_REPLY" in udp
assert "WSJTX_MESSAGE_REPLAY" in udp
assert "WSJTX_MESSAGE_HALT_TX" in udp
print("WSJT-X UDP transport contract: OK")
