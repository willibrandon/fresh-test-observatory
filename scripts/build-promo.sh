#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source_root=${1:-"$repo_root/.artifacts/promo"}
asset_root="$repo_root/docs/assets"
font=${PROMO_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf}

for name in discovery nearest run-all coverage; do
  if [[ ! -f "$source_root/$name.png" ]]; then
    echo "Missing $source_root/$name.png" >&2
    exit 1
  fi
done

mkdir -p "$asset_root"

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -t 2.5 -i "color=c=0x0a0a0a:s=1280x720:r=30" \
  -loop 1 -framerate 30 -t 4 -i "$source_root/discovery.png" \
  -loop 1 -framerate 30 -t 4 -i "$source_root/nearest.png" \
  -loop 1 -framerate 30 -t 4 -i "$source_root/run-all.png" \
  -loop 1 -framerate 30 -t 4 -i "$source_root/coverage.png" \
  -f lavfi -t 2.5 -i "color=c=0x0a0a0a:s=1280x720:r=30" \
  -filter_complex "
    [0:v]drawtext=fontfile='$font':text='Test Observatory':fontcolor=0x00d9a3:fontsize=58:x=(w-text_w)/2:y=280,
         drawtext=fontfile='$font':text='Tests, where you work.':fontcolor=0xd4d4d4:fontsize=25:x=(w-text_w)/2:y=370,format=yuv420p[v0];
    [1:v]pad=1280:720:1:0:0x0a0a0a,zoompan=z='min(zoom+0.00012,1.015)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1280x720:fps=30,
         drawtext=fontfile='$font':text='.NET  ·  Rust  ·  Go':fontcolor=0x00d9a3:fontsize=25:x=w-text_w-42:y=38:box=1:boxcolor=black@0.72:boxborderw=14,format=yuv420p[v1];
    [2:v]pad=1280:720:1:0:0x0a0a0a,zoompan=z='min(zoom+0.00012,1.015)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1280x720:fps=30,
         drawtext=fontfile='$font':text='Nearest  ·  one result':fontcolor=0x00d9a3:fontsize=25:x=w-text_w-42:y=38:box=1:boxcolor=black@0.72:boxborderw=14,format=yuv420p[v2];
    [3:v]pad=1280:720:1:0:0x0a0a0a,zoompan=z='min(zoom+0.00012,1.015)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1280x720:fps=30,
         drawtext=fontfile='$font':text='11 passed  ·  3 skipped  ·  40 ms':fontcolor=0x00d9a3:fontsize=24:x=w-text_w-42:y=38:box=1:boxcolor=black@0.72:boxborderw=14,format=yuv420p[v3];
    [4:v]pad=1280:720:1:0:0x0a0a0a,zoompan=z='min(zoom+0.00012,1.015)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1280x720:fps=30,
         drawtext=fontfile='$font':text='Coverage stays beside the code':fontcolor=0x00d9a3:fontsize=24:x=w-text_w-42:y=38:box=1:boxcolor=black@0.72:boxborderw=14,format=yuv420p[v4];
    [5:v]drawtext=fontfile='$font':text='fresh-test-observatory':fontcolor=0x00d9a3:fontsize=38:x=(w-text_w)/2:y=300,
         drawtext=fontfile='$font':text='Built for Fresh':fontcolor=0xd4d4d4:fontsize=22:x=(w-text_w)/2:y=370,format=yuv420p[v5];
    [v0][v1]xfade=transition=fade:duration=0.5:offset=2.0[x1];
    [x1][v2]xfade=transition=fade:duration=0.5:offset=5.5[x2];
    [x2][v3]xfade=transition=fade:duration=0.5:offset=9.0[x3];
    [x3][v4]xfade=transition=fade:duration=0.5:offset=12.5[x4];
    [x4][v5]xfade=transition=fade:duration=0.5:offset=16.0[out]
  " \
  -map "[out]" -an -c:v libx264 -preset medium -crf 21 -pix_fmt yuv420p -movflags +faststart \
  "$asset_root/test-observatory-promo.mp4"

ffmpeg -y -hide_banner -loglevel error -i "$source_root/run-all.png" \
  -vf "pad=1280:720:1:0:0x0a0a0a,
       drawtext=fontfile='$font':text='Test Observatory':fontcolor=0x00d9a3:fontsize=40:x=w-text_w-42:y=44:box=1:boxcolor=black@0.76:boxborderw=16,
       drawtext=fontfile='$font':text='Tests, where you work.':fontcolor=0xd4d4d4:fontsize=21:x=w-text_w-42:y=118:box=1:boxcolor=black@0.76:boxborderw=12" \
  -frames:v 1 "$asset_root/promo-poster.png"

echo "Built $asset_root/test-observatory-promo.mp4"
echo "Built $asset_root/promo-poster.png"
