"""Generate only invented points; requires laspy==2.7.0 and lazrs==0.8.2 (not runtime deps)."""
from datetime import date
from pathlib import Path
import struct

import laspy
import lazrs

ROOT = Path(__file__).resolve().parent / "fixtures/point-cloud"
WKT = ('GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],'
       'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],'
       'AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]\0')

assert ROOT.is_dir(), "Create the owned sample directory before generating fixtures."
for fmt in range(11):
    header = laspy.LasHeader(point_format=fmt, version="1.2" if fmt <= 3 else "1.3" if fmt <= 5 else "1.4")
    header.creation_date = date(2026, 10, 10)
    header.generating_software = "synthetic point-cloud check"
    header.system_identifier = "No survey or real data"
    header.scales = [0.000001, 0.000001, 0.01]
    header.offsets = [135.0, 35.0, 10.0]
    if fmt <= 5:
        # GeoTIFF model=geographic, GeographicTypeGeoKey=EPSG:4326, degrees.
        keys = [1, 1, 0, 3, 1024, 0, 1, 2, 2048, 0, 1, 4326, 2054, 0, 1, 9102]
        header.vlrs.append(laspy.VLR("LASF_Projection", 34735, "Synthetic WGS84 GeoKeys", struct.pack("<16H", *keys)))
    else:
        header.global_encoding.wkt = True
        header.vlrs.append(laspy.VLR("LASF_Projection", 2112, "Synthetic WGS84 WKT", WKT.encode()))
    cloud = laspy.LasData(header)
    cloud.X = [0, 100, 250]
    cloud.Y = [0, 200, 400]
    cloud.Z = [-1400, 300, 1800]
    cloud.return_number = [1, 1, 1]
    cloud.number_of_returns = [1, 1, 1]
    cloud.synthetic = [1, 1, 1]
    if fmt in [2, 3, 5, 7, 8, 10]:
        cloud.red = [65535, 0, 32768]
        cloud.green = [0, 65535, 32768]
        cloud.blue = [0, 0, 65535]
    if fmt in [8, 10]:
        cloud.nir = [1000, 2000, 3000]
    if "gps_time" in cloud.point_format.dimension_names:
        cloud.gps_time = [1.25, 2.5, 3.75]
    if fmt in [4, 5, 9, 10]:
        # Index zero means no waveform samples are attached. No external WDP is required.
        # Vary the opaque waveform fields to exercise their lossless compression too.
        cloud.wavepacket_index = [0, 0, 0]
        cloud.wavepacket_offset = [0, 64, 128]
        cloud.wavepacket_size = [0, 16, 32]
        cloud.return_point_wave_location = [0.0, 0.25, 0.5]
        cloud.x_t = [0.0, 1.0, -1.0]
        cloud.y_t = [0.0, 2.0, -2.0]
        cloud.z_t = [0.0, 3.0, -3.0]
    cloud.write(ROOT / f"cloud{fmt}.las")
    cloud.write(ROOT / f"cloud{fmt}.laz", laz_backend=laspy.LazBackend.Lazrs)
    restored = laspy.read(ROOT / f"cloud{fmt}.laz", laz_backend=laspy.LazBackend.Lazrs)
    assert restored.points.array.tobytes() == cloud.points.array.tobytes()
# Derive two LASzip framing variants from the single, genuinely compressed format-0 chunk.
source = bytearray((ROOT / "cloud0.laz").read_bytes())
point_start = struct.unpack_from("<I", source, 96)[0]
table = struct.unpack_from("<Q", source, point_start)[0]
assert struct.unpack_from("<I", source, table + 4)[0] == 1
pos = struct.unpack_from("<H", source, 94)[0]
for _ in range(struct.unpack_from("<I", source, 100)[0]):
    length = struct.unpack_from("<H", source, pos + 20)[0]
    if bytes(source[pos + 2:pos + 18]).rstrip(b"\0") == b"laszip encoded":
        struct.pack_into("<H", source, pos + 54, 1)  # pointwise compressor, no table pointer
        break
    pos += 54 + length
else:
    raise AssertionError("Missing LASzip VLR")
(ROOT / "cloud0-pointwise.laz").write_bytes(source[:point_start] + source[point_start + 8:table])
source = bytearray((ROOT / "cloud0.laz").read_bytes())
struct.pack_into("<q", source, point_start, -1)
(ROOT / "cloud0-tail-table.laz").write_bytes(source + struct.pack("<Q", table))
# ponytail: lazrs 0.8.2 cannot encode item v4; use a laz 0.13 encoder if a v4 fixture is required.
for fmt, version in [(0, 1)]:
    source = bytearray((ROOT / f"cloud{fmt}.laz").read_bytes())
    point_start = struct.unpack_from("<I", source, 96)[0]
    pos = struct.unpack_from("<H", source, 94)[0]
    for _ in range(struct.unpack_from("<I", source, 100)[0]):
        length = struct.unpack_from("<H", source, pos + 20)[0]
        if bytes(source[pos + 2:pos + 18]).rstrip(b"\0") == b"laszip encoded":
            body = bytearray(source[pos + 54:pos + 54 + length])
            for i in range(struct.unpack_from("<H", body, 32)[0]):
                struct.pack_into("<H", body, 38 + i * 6, version)
            source[pos + 54:pos + 54 + length] = body
            break
        pos += 54 + length
    else:
        raise AssertionError("Missing LASzip VLR")
    raw = laspy.read(ROOT / f"cloud{fmt}.las").points.array.tobytes()
    compressed = bytearray(lazrs.compress_points(lazrs.LazVlr(bytes(body)), raw, False))
    struct.pack_into("<Q", compressed, 0, struct.unpack_from("<Q", compressed, 0)[0] + point_start)
    path = ROOT / f"cloud{fmt}-item-v{version}.laz"
    path.write_bytes(source[:point_start] + compressed)
    assert laspy.read(path, laz_backend=laspy.LazBackend.Lazrs).points.array.tobytes() == raw
print("Generated 22 LAS/LAZ twins + 3 synthetic LAZ framing/item-version variants; raw-record round-trips verified.")
