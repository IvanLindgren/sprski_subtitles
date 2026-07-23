import { notifyIndexNow } from '../indexnow.mjs';

const sitemapUrl = 'https://serbiansubtitles.online/sitemap.xml';
const response = await fetch(sitemapUrl, { signal: AbortSignal.timeout(20_000) });
if (!response.ok) throw new Error(`Не удалось получить Sitemap: ${response.status}`);
const xml = await response.text();
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].replaceAll('&amp;', '&'));
const result = await notifyIndexNow(urls);
if (![200, 202].includes(result.status)) process.exitCode = 1;
