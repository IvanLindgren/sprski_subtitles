export const SUBTITLE_DELAY_SECONDS = 0.4;

export function subtitleTime(seconds, delaySeconds = SUBTITLE_DELAY_SECONDS) {
  return Math.max(0, (Number(seconds) || 0) + delaySeconds);
}

export function isSubtitleActive(segment, currentTime, delaySeconds = SUBTITLE_DELAY_SECONDS) {
  return currentTime >= subtitleTime(segment.start, delaySeconds)
    && currentTime < subtitleTime(segment.end, delaySeconds);
}

export function formatClock(seconds, withMillis = false) {
  const safe = Math.max(0, Number(seconds) || 0);
  const totalMillis = Math.round(safe * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  const base = [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
  return withMillis ? `${base}.${String(millis).padStart(3, '0')}` : `${minutes + hours * 60}:${String(secs).padStart(2, '0')}`;
}

export function makeVtt(segments, delaySeconds = SUBTITLE_DELAY_SECONDS) {
  const body = segments
    .map((segment) => `${formatClock(subtitleTime(segment.start, delaySeconds), true)} --> ${formatClock(subtitleTime(segment.end, delaySeconds), true)}\n${segment.text.trim()}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

export function makeSrt(segments, delaySeconds = SUBTITLE_DELAY_SECONDS) {
  return segments
    .map((segment, index) => {
      const start = formatClock(subtitleTime(segment.start, delaySeconds), true).replace('.', ',');
      const end = formatClock(subtitleTime(segment.end, delaySeconds), true).replace('.', ',');
      return `${index + 1}\n${start} --> ${end}\n${segment.text.trim()}`;
    })
    .join('\n\n');
}

export function downloadText(contents, filename, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function cleanWord(value) {
  return value
    .toLocaleLowerCase('sr')
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
    .trim();
}
