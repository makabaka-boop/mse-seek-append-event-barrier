#!/bin/sh
# generate-media.sh — 可复现生成 media/ 下的 WebM/VP8 分片：
#   init.webm（初始化段）+ seg-1..6.webm（各 1s、关键帧起始、绝对时间戳）
#
# 复现保证：
#   - 固定 ffmpeg 7.0.2 静态构建（按架构下载，sha256 校验）
#   - 固定输入（lavfi testsrc2，确定性图案）与固定编码参数、单线程
#   - -bitexact 消除头部随机 UID
#   - 生成后与 media/media.sha256 比对，字节级一致即通过
#
# 用法：sh tools/generate-media.sh   （或 docker compose run media-gen）
set -eu

FFVER=7.0.2
SHA_AMD64=abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67
SHA_ARM64=f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1

cd "$(dirname "$0")/.."

case "$(uname -m)" in
  x86_64|amd64)  FFARCH=amd64; FFSHA=$SHA_AMD64 ;;
  aarch64|arm64) FFARCH=arm64; FFSHA=$SHA_ARM64 ;;
  *) echo "不支持的架构: $(uname -m)" >&2; exit 1 ;;
esac
FFURL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-${FFVER}-${FFARCH}-static.tar.xz"

# alpine 等最小环境补齐依赖
if ! command -v curl >/dev/null 2>&1; then
  apk add --no-cache curl xz ca-certificates 2>/dev/null \
    || apt-get update && apt-get install -y curl xz-utils ca-certificates
fi

CACHE=tools/.cache
mkdir -p "$CACHE"
TARBALL="$CACHE/ffmpeg-${FFVER}-${FFARCH}-static.tar.xz"
if [ ! -f "$TARBALL" ]; then
  echo ">> 下载 $FFURL"
  curl -fsSL -o "$TARBALL" "$FFURL"
fi
echo "$FFSHA  $TARBALL" | sha256sum -c -
if [ ! -x "$CACHE/ffmpeg-${FFARCH}" ]; then
  tar -xJf "$TARBALL" -C "$CACHE"
  cp "$CACHE/ffmpeg-${FFVER}-${FFARCH}-static/ffmpeg" "$CACHE/ffmpeg-${FFARCH}"
  cp "$CACHE/ffmpeg-${FFVER}-${FFARCH}-static/ffprobe" "$CACHE/ffprobe-${FFARCH}"
fi
FF="$CACHE/ffmpeg-${FFARCH}"
FP="$CACHE/ffprobe-${FFARCH}"

echo ">> 生成 init.webm + seg-1..6.webm（VP8，GOP=30@30fps，webm_chunk 按关键帧切分）"
rm -f media/init.webm media/seg-*.webm
"$FF" -hide_banner -loglevel warning -y \
  -f lavfi -i "testsrc2=size=320x180:rate=30:duration=6" \
  -map 0:v:0 -an -c:v libvpx -b:v 300k -threads 1 -g 30 -keyint_min 30 -bitexact \
  -f webm_chunk -header media/init.webm -chunk_start_index 1 "media/seg-%d.webm"

echo ">> 校验：每段首帧为关键帧且起始时间戳为 (seq-1) 秒"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
i=1
while [ "$i" -le 6 ]; do
  cat media/init.webm "media/seg-$i.webm" > "$TMP/probe.webm"
  first=$("$FP" -v error -select_streams v \
    -show_entries packet=pts_time,flags -of csv=p=0 \
    -read_intervals "%+0.04" "$TMP/probe.webm" | head -1)
  expect="$((i - 1)).000000,K"
  case "$first" in
    "$expect"*) : ;;
    *) echo "seg-$i 首帧异常: $first（期望 $expect...）" >&2; exit 1 ;;
  esac
  i=$((i + 1))
done

echo ">> 写 media/manifest.json"
cat > media/manifest.json <<'EOF'
{
  "init": "init.webm",
  "mimeType": "video/webm; codecs=\"vp8\"",
  "comment": "固定清单：6 个关键帧起始媒体段，各 1s，绝对时间戳；由 tools/generate-media.sh 可复现生成",
  "segments": [
    { "seq": 1, "url": "seg-1.webm", "start": 0, "end": 1 },
    { "seq": 2, "url": "seg-2.webm", "start": 1, "end": 2 },
    { "seq": 3, "url": "seg-3.webm", "start": 2, "end": 3 },
    { "seq": 4, "url": "seg-4.webm", "start": 3, "end": 4 },
    { "seq": 5, "url": "seg-5.webm", "start": 4, "end": 5 },
    { "seq": 6, "url": "seg-6.webm", "start": 5, "end": 6 }
  ]
}
EOF

echo ">> 与 media/media.sha256 比对（可复现性证明）"
if [ -f media/media.sha256 ]; then
  (cd media && sha256sum -c media.sha256)
  echo "OK：生成结果与仓库校验和一致"
else
  (cd media && sha256sum init.webm seg-*.webm > media.sha256)
  echo "已写入新的 media/media.sha256（首次生成）"
fi
