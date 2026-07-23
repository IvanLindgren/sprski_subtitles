export const INDEXNOW_HOST = 'serbiansubtitles.online';
export const INDEXNOW_KEY = 'ae4f2f23b452ba5956d94a705c9b8352f609c75941f61b6b';
export const INDEXNOW_KEY_LOCATION = `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`;

export async function notifyIndexNow(urls, { log = console.log, warn = console.warn } = {}) {
  const urlList = [...new Set((urls || []).map((value) => String(value || '').trim()).filter(Boolean))]
    .filter((value) => {
      try {
        return new URL(value).hostname === INDEXNOW_HOST;
      } catch {
        return false;
      }
    })
    .slice(0, 10_000);
  if (!urlList.length) return { status: 0, submitted: 0 };

  const response = await fetch('https://yandex.com/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: INDEXNOW_HOST,
      key: INDEXNOW_KEY,
      keyLocation: INDEXNOW_KEY_LOCATION,
      urlList,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 200 || response.status === 202) {
    log(`[indexnow] Яндекс принял ${urlList.length} URL, статус ${response.status}`);
    return { status: response.status, submitted: urlList.length };
  }

  const details = (await response.text().catch(() => '')).slice(0, 500);
  warn(`[indexnow] Яндекс отклонил запрос: ${response.status}${details ? ` · ${details}` : ''}`);
  return { status: response.status, submitted: 0 };
}
