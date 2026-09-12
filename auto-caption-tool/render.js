// Client-side video assembly: trims each segment, concatenates them in order,
// then hard-subs captions with a burned-in ASS track. Runs entirely in the
// browser via a self-hosted ffmpeg.wasm build (see vendor/ffmpeg/) — no
// server involved, so there's nothing to deploy beyond this static site.
import { FFmpeg } from './vendor/ffmpeg/ffmpeg/index.js';
import { fetchFile } from './vendor/ffmpeg/util/index.js';

let ffmpegInstance = null;
let ffmpegLoadPromise = null;

function coreBaseUrl() {
  return new URL('./vendor/ffmpeg/core/', import.meta.url).href;
}

export function getFontUrl() {
  return new URL('./vendor/fonts/Pretendard-Bold.ttf', import.meta.url).href;
}

async function getFFmpeg(onLog) {
  if (ffmpegInstance) return ffmpegInstance;
  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const base = coreBaseUrl();
      await ffmpeg.load({
        coreURL: base + 'ffmpeg-core.js',
        wasmURL: base + 'ffmpeg-core.wasm',
      });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })();
  }
  const ffmpeg = await ffmpegLoadPromise;
  if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
  return ffmpeg;
}

function secToAssTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

// ASS uses &HAABBGGRR (alpha-blue-green-red, hex, alpha 00=opaque).
function hexToAssColor(hex, alpha = '00') {
  const clean = hex.replace('#', '');
  const r = clean.slice(0, 2), g = clean.slice(2, 4), b = clean.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

function buildAss(playlist, opts) {
  const primary = hexToAssColor(opts.textColor || '#FFFFFF');
  const outline = hexToAssColor(opts.outlineColor || '#000000');
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${opts.width}
PlayResY: ${opts.height}
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${opts.fontName},${opts.fontSize},${primary},&H000000FF,${outline},&H00000000,0,0,0,0,100,100,0,0,1,${opts.outline},${opts.shadow},${opts.alignment},20,20,${opts.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  let cursor = 0;
  const lines = playlist.map(({ seg }) => {
    const dur = Math.max(0, seg.end - seg.start);
    const start = cursor, end = cursor + dur;
    cursor = end;
    if (!seg.caption) return '';
    return `Dialogue: 0,${secToAssTime(start)},${secToAssTime(end)},Default,,0,0,0,,${escapeAssText(seg.caption)}`;
  }).filter(Boolean).join('\n');
  return header + lines + '\n';
}

function extFor(file) {
  const m = /\.[^.]+$/.exec(file.name || '');
  return m ? m[0] : '.mp4';
}

const DEFAULT_STYLE = {
  fontName: 'Pretendard',
  fontSize: 64,
  textColor: '#FFFFFF',
  outlineColor: '#000000',
  outline: 3,
  shadow: 0,
  alignment: 2, // ASS numpad alignment: 2 = bottom-center
  marginV: 90,
};

// playlist: [{ clip: { file }, seg: { start, end, caption } }, ...] in final order.
// options: { width, height, fps, style: {...DEFAULT_STYLE overrides} }
// callbacks: { onLog(msg), onProgress(ratio), onStage(text) }
export async function renderFinalVideo(playlist, options, callbacks = {}) {
  const { onLog, onProgress, onStage } = callbacks;
  if (!playlist.length) throw new Error('구간이 없습니다.');

  const width = options.width || 1080;
  const height = options.height || 1920;
  const fps = options.fps || 30;
  const style = { ...DEFAULT_STYLE, ...(options.style || {}) };

  const ffmpeg = await getFFmpeg(onLog);
  const progressHandler = ({ progress }) => onProgress && onProgress(Math.max(0, Math.min(1, progress)));
  if (onProgress) ffmpeg.on('progress', progressHandler);

  const writtenFiles = [];
  const track = async (name, bytes) => { await ffmpeg.writeFile(name, bytes); writtenFiles.push(name); };

  try {
    await ffmpeg.createDir('/fonts').catch(() => {});
    const fontBytes = await fetchFile(getFontUrl());
    await track('/fonts/Pretendard-Bold.ttf', fontBytes);

    const segFiles = [];
    for (let i = 0; i < playlist.length; i++) {
      onStage && onStage(`구간 ${i + 1}/${playlist.length} 트리밍 중...`);
      const { clip, seg } = playlist[i];
      const inputName = `in_${i}${extFor(clip.file)}`;
      await track(inputName, await fetchFile(clip.file));
      const outName = `seg_${i}.mp4`;
      const vf = `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
      const ret = await ffmpeg.exec([
        '-i', inputName,
        '-ss', String(seg.start), '-to', String(seg.end),
        '-vf', vf,
        '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        outName,
      ]);
      if (ret !== 0) throw new Error(`구간 ${i + 1} 트리밍 실패 (ffmpeg exit ${ret})`);
      writtenFiles.push(outName);
      segFiles.push(outName);
      await ffmpeg.deleteFile(inputName);
      writtenFiles.splice(writtenFiles.indexOf(inputName), 1);
    }

    onStage && onStage('클립을 순서대로 이어붙이는 중...');
    const listContent = segFiles.map(f => `file '${f}'`).join('\n');
    await track('concat_list.txt', new TextEncoder().encode(listContent));
    let ret = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'concat_list.txt', '-c', 'copy', 'concat_out.mp4']);
    if (ret !== 0) throw new Error(`클립 합치기 실패 (ffmpeg exit ${ret})`);
    writtenFiles.push('concat_out.mp4');

    onStage && onStage('자막 하드섭 처리 중...');
    const assContent = buildAss(playlist, { width, height, ...style });
    await track('captions.ass', new TextEncoder().encode(assContent));
    ret = await ffmpeg.exec([
      '-i', 'concat_out.mp4',
      '-vf', `ass=captions.ass:fontsdir=/fonts`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      'final_output.mp4',
    ]);
    if (ret !== 0) throw new Error(`자막 하드섭 실패 (ffmpeg exit ${ret})`);
    writtenFiles.push('final_output.mp4');

    const data = await ffmpeg.readFile('final_output.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    if (onProgress) ffmpeg.off('progress', progressHandler);
    for (const f of writtenFiles) {
      await ffmpeg.deleteFile(f).catch(() => {});
    }
  }
}
