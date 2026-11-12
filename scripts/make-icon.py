"""Generates assets/icon.ico and assets/icon.png (original artwork).

A dark rounded tile split into two panes, with a prompt chevron and cursor
in the app's accent colour. Pure standard library: rasterised with 4x4
supersampling and written as PNG-compressed ICO entries.

Usage: python scripts/make-icon.py
"""
import struct
import zlib
from pathlib import Path

BG = (24, 27, 32)
PANE = (16, 18, 21)
EDGE = (58, 63, 72)
ACCENT = (98, 201, 173)
SS = 4


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    qx, qy = ax + t * dx, ay + t * dy
    return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5


def sample(u, v):
    """Colour (r, g, b, a) at normalised coordinates u, v in [0, 1]."""
    if not inside_round_rect(u, v, 0.04, 0.04, 0.96, 0.96, 0.2):
        return (0, 0, 0, 0)
    color = BG
    # Two panes separated by a gap.
    left = inside_round_rect(u, v, 0.13, 0.15, 0.6, 0.85, 0.06)
    right = inside_round_rect(u, v, 0.66, 0.15, 0.87, 0.85, 0.06)
    if left or right:
        color = PANE
    # Pane outline.
    if not left and inside_round_rect(u, v, 0.12, 0.14, 0.61, 0.86, 0.07):
        color = EDGE
    if not right and inside_round_rect(u, v, 0.65, 0.14, 0.88, 0.86, 0.07):
        color = EDGE
    # Prompt chevron and cursor in the left pane.
    w = 0.045
    if dist_to_segment(u, v, 0.22, 0.36, 0.34, 0.5) <= w or dist_to_segment(u, v, 0.34, 0.5, 0.22, 0.64) <= w:
        color = ACCENT
    if 0.39 <= u <= 0.52 and 0.6 <= v <= 0.68:
        color = ACCENT
    # Muted lines in the right pane.
    for y in (0.3, 0.42, 0.54):
        if 0.71 <= u <= 0.82 and y <= v <= y + 0.045:
            color = EDGE
    return (*color, 255)


def render(size):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    r, g, b, a = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = SS * SS
            alpha = acc[3] / n
            if alpha == 0:
                row += bytes(4)
            else:
                row += bytes((round(acc[0] / acc[3]), round(acc[1] / acc[3]), round(acc[2] / acc[3]), round(alpha)))
        rows.append(bytes(row))
    return rows


def png(size, rows):
    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    raw = b''.join(b'\x00' + r for r in rows)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def main():
    out = Path(__file__).resolve().parent.parent / 'assets'
    out.mkdir(exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [png(s, render(s)) for s in sizes]
    header = struct.pack('<HHH', 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b''
    for s, data in zip(sizes, images):
        entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    (out / 'icon.ico').write_bytes(header + entries + b''.join(images))
    (out / 'icon.png').write_bytes(images[-1])
    print('wrote', out / 'icon.ico')


if __name__ == '__main__':
    main()
