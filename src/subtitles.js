export function formatClock(seconds, withMillis = false) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 1000);
  const base = [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
  return withMillis ? `${base}.${String(millis).padStart(3, '0')}` : `${minutes + hours * 60}:${String(secs).padStart(2, '0')}`;
}

export function makeVtt(segments) {
  const body = segments
    .map((segment) => `${formatClock(segment.start, true)} --> ${formatClock(segment.end, true)}\n${segment.text.trim()}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

export function makeSrt(segments) {
  return segments
    .map((segment, index) => {
      const start = formatClock(segment.start, true).replace('.', ',');
      const end = formatClock(segment.end, true).replace('.', ',');
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
