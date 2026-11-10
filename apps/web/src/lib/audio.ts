/**
 * Voice notes are recorded as webm/opus (or mp4, or ogg) because that is what MediaRecorder offers.
 * Speech-to-text through a multimodal chat model accepts only wav and mp3, so the recording is
 * decoded and re-encoded here, in the browser, where the codecs already live. Converting on the
 * server would mean shipping an opus decoder or ffmpeg into a serverless function.
 *
 * 16 kHz mono is what speech models want, and it keeps the upload small: one minute is about 2 MB,
 * well inside the 4 MB request limit.
 */

const TARGET_RATE = 16_000;

/**
 * Re-encodes a recording as 16 kHz mono WAV. Returns the original file untouched when the browser
 * cannot decode it, so a voice note is still sent (and a Whisper-style provider can read it).
 */
export async function toWavFile(file: File): Promise<File> {
  if (file.type.includes('wav')) return file;
  try {
    const AudioCtx: typeof AudioContext | undefined = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return file;
    const ctx = new AudioCtx();
    try {
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      const mono = downmixTo(decoded, TARGET_RATE);
      return new File([wavBytes(mono, TARGET_RATE)], file.name.replace(/\.\w+$/, '') + '.wav', { type: 'audio/wav' });
    } finally {
      void ctx.close();
    }
  } catch {
    return file;
  }
}

/** Averages the channels and resamples by linear interpolation: enough for speech at 16 kHz. */
function downmixTo(buffer: AudioBuffer, rate: number): Float32Array {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const ratio = buffer.sampleRate / rate;
  const out = new Float32Array(Math.max(1, Math.floor(buffer.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, buffer.length - 1);
    const t = at - low;
    let sum = 0;
    for (const ch of channels) sum += ch[low]! * (1 - t) + ch[high]! * t;
    out[i] = sum / channels.length;
  }
  return out;
}

/** A 16-bit PCM WAV container around the samples. */
function wavBytes(samples: Float32Array, rate: number): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(clamped * 32_767), true);
  }
  return bytes;
}
