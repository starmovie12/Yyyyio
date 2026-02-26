import axios from 'axios';
import * as cheerio from 'cheerio';
import {
  API_TIMEOUTS,
  GlobalTimeoutBudget,
  safeFetch,
  getAxiosConfig,
} from './timeout';

// =============================================================================
// BROWSER-LIKE HEADERS
// =============================================================================
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
};

const MOBILE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

// =============================================================================
// CLOUDFLARE-SAFE PAGE FETCHER — WITH SMART TIMEOUT
// =============================================================================

/**
 * Fetches HTML through the Python cloudscraper proxy (port 5001).
 * Falls back to direct fetch if proxy is unavailable.
 * 
 * ✅ SMART TIMEOUT: 
 *   - Proxy: max 20s (fast response → turant aage)
 *   - Direct: max 12s
 *   - Global budget aware
 */
async function fetchPageHTML(
  url: string,
  budget?: GlobalTimeoutBudget
): Promise<{ html: string; finalUrl: string }> {
  const PROXY_URL = "http://127.0.0.1:5001/fetch";

  // ========== PLAN A: Cloudscraper proxy ==========
  try {
    if (budget?.isExpired) throw new Error('Budget expired, skipping proxy');

    console.log(`[Fetcher] 🔄 Trying proxy for: ${url} ${budget?.getStatus() || ''}`);

    const proxyResp = await safeFetch(
      `${PROXY_URL}?url=${encodeURIComponent(url)}`,
      { timeoutMs: API_TIMEOUTS.PROXY_FETCH },
      budget
    );
    const data = await proxyResp.json();

    if (data.status === "success" && data.html) {
      console.log(`[Fetcher] ✅ Proxy success for: ${url} (HTTP ${data.status_code}, ${data.content_length} chars)`);

      if (data.status_code === 403 || data.status_code === 503) {
        console.log(`[Fetcher] ⚠️ Proxy got HTTP ${data.status_code} — still blocked`);
        throw new Error(`Blocked with HTTP ${data.status_code}`);
      }

      const cfMarkers = ['cf-challenge', 'Just a moment...', 'Checking your browser', 'cf-turnstile'];
      if (cfMarkers.some(marker => data.html.includes(marker))) {
        console.log(`[Fetcher] ⚠️ Cloudflare challenge detected in response HTML`);
        throw new Error('Cloudflare challenge page received');
      }

      return { html: data.html, finalUrl: data.url || url };
    }

    throw new Error(data.message || "Proxy returned non-success");
  } catch (proxyErr: any) {
    console.warn(`[Fetcher] ⚠️ Proxy failed: ${proxyErr.message}. Trying direct fetch...`);
  }

  // ========== PLAN B: Direct fetch ==========
  if (budget?.isExpired) {
    throw new Error('⏱️ Budget expired before direct fetch attempt');
  }

  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "Referer": "https://www.google.com/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
  };

  const response = await safeFetch(
    url,
    { headers: HEADERS, timeoutMs: API_TIMEOUTS.DIRECT_FETCH },
    budget
  );

  if (!response.ok) {
    throw new Error(`Direct fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  const cfMarkers = ['cf-challenge', 'Just a moment...', 'Checking your browser'];
  if (cfMarkers.some(marker => html.includes(marker))) {
    throw new Error('Cloudflare challenge on direct fetch — proxy needed but unavailable');
  }

  console.log(`[Fetcher] ✅ Direct fetch success for: ${url} (${html.length} chars)`);
  return { html, finalUrl: url };
}

// =============================================================================
// HBLINKS SOLVER — WITH SMART TIMEOUT
// =============================================================================

/**
 * ✅ SMART TIMEOUT: max 10s via axios timeout + AbortController
 * Fast response → turant done, slow → abort at 10s
 */
export async function solveHBLinks(url: string, budget?: GlobalTimeoutBudget) {
  try {
    if (budget?.isExpired) {
      return { status: "error", message: "⏱️ Budget expired before HBLinks" };
    }

    const axiosConfig = getAxiosConfig(API_TIMEOUTS.HBLINKS, budget, { headers: BROWSER_HEADERS });

    try {
      const response = await axios.get(url, {
        headers: BROWSER_HEADERS,
        timeout: axiosConfig.timeout,
        signal: axiosConfig.signal,
      });

      if (response.status !== 200) {
        return { status: "fail", message: `Cannot open page. Status: ${response.status}` };
      }

      const $ = cheerio.load(response.data);
      
      const HUBCLOUD_TLDS = ['.foo', '.fans', '.dev', '.cloud', '.icu', '.lol', '.art', '.in', '.store'];
      for (const tld of HUBCLOUD_TLDS) {
        const found = $(`a[href*="hubcloud${tld}"]`).attr('href');
        if (found) {
          return { status: "success", link: found, source: `HubCloud${tld} (Priority 1)` };
        }
      }

      const HUBDRIVE_TLDS = ['.space', '.pro', '.in'];
      for (const tld of HUBDRIVE_TLDS) {
        const found = $(`a[href*="hubdrive${tld}"]`).attr('href');
        if (found) {
          return { status: "success", link: found, source: `HubDrive${tld} (Priority 2)` };
        }
      }

      const genericHub = $('a[href*="hubcloud"], a[href*="hubdrive"]').first().attr('href');
      if (genericHub) {
        return { status: "success", link: genericHub, source: "HubCloud/HubDrive (Generic)" };
      }
          
      return { status: "fail", message: "Not Found" };
    } finally {
      clearTimeout(axiosConfig._cleanupTimer);
    }

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

// =============================================================================
// JUNK LINK FILTERING
// =============================================================================

const JUNK_LINK_TEXTS = [
  "how to download",
  "[how to download]",
  "how to watch",
  "[how to watch]",
  "join telegram",
  "join our telegram",
  "request movie",
  "4k | sdr | hevc",
  "4k | sdr",
  "sdr | hevc",
];

const JUNK_LINK_EXACT_TEXTS = [
  "4k",
  "sdr",
  "hevc",
];

function isJunkLink(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (JUNK_LINK_TEXTS.some(junk => lower.includes(junk))) return true;
  if (JUNK_LINK_EXACT_TEXTS.some(junk => lower === junk)) return true;
  return false;
}

// =============================================================================
// MOVIE PREVIEW EXTRACTOR
// =============================================================================

export function extractMoviePreview(html: string): { title: string; posterUrl: string | null } {
  const $ = cheerio.load(html);

  let title = '';
  const h1 = $('h1.entry-title, h1.post-title, h1').first().text().trim();
  if (h1) {
    title = h1;
  } else {
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    title = ogTitle || $('title').text().trim() || 'Unknown Movie';
  }
  title = title.replace(/\s*[-\u2013|].*?(HDHub|HdHub|hdhub|Download|Free).*$/i, '').trim();

  let posterUrl: string | null = null;
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage && !ogImage.includes('logo') && !ogImage.includes('favicon')) {
    posterUrl = ogImage;
  } else {
    const contentImg = $('.entry-content img, .post-content img, main img').first().attr('src');
    if (contentImg && !contentImg.includes('logo') && !contentImg.includes('icon')) {
      posterUrl = contentImg;
    }
  }

  return { title, posterUrl };
}

// =============================================================================
// MAIN LINK EXTRACTOR — WITH SMART TIMEOUT
// =============================================================================

export async function extractMovieLinks(url: string, budget?: GlobalTimeoutBudget) {
  const JUNK_DOMAINS = [
    "catimages", "imdb.com", "googleusercontent", "instagram.com",
    "facebook.com", "wp-content", "wpshopmart"
  ];

  try {
    if (budget?.isExpired) {
      return { status: "error", message: "⏱️ Budget expired before page extraction" };
    }

    const { html } = await fetchPageHTML(url, budget);
    const $ = cheerio.load(html);

    const foundLinks: { name: string; link: string }[] = [];
    const metadata = extractMovieMetadata(html);
    const preview = extractMoviePreview(html);

    const pageTitle = $('title').text().trim();
    const hasEntryContent = $('.entry-content').length > 0;
    const totalAnchors = $('a').length;

    console.log(`[extractMovieLinks] Page title: "${pageTitle}"`);
    console.log(`[extractMovieLinks] .entry-content found: ${hasEntryContent}, Total <a>: ${totalAnchors}`);

    $('.entry-content a[href], main a[href]').each((_idx: number, el: any) => {
      const $a = $(el);
      const link = $a.attr('href') || '';
      const text = $a.text().trim();
      
      if (!link || link.startsWith('#') || JUNK_DOMAINS.some(junk => link.includes(junk))) return;
      if (isJunkLink(text)) return;
      
      const $parent = $a.closest('p, div, h3, h4');
      const parentText = $parent.text().trim();
      if (isJunkLink(parentText)) return;
      
      const isTargetDomain = ["hblinks", "hubdrive", "hubcdn", "hubcloud", "gdflix", "drivehub"].some(d => link.includes(d));
      const isDownloadText = ["DOWNLOAD", "720P", "480P", "1080P", "4K", "DIRECT", "GDRIVE"].some(t => text.toUpperCase().includes(t));

      if (isTargetDomain || isDownloadText) {
        if (!foundLinks.some(x => x.link === link)) {
          let cleanName = text.replace(/\u26A1/g, "").trim();
          if (!cleanName || cleanName.length < 2) {
            const parent = $a.closest('p, div, h3, h4');
            const prev = parent.prev('h3, h4, h5, strong');
            cleanName = prev.text().trim() || parent.text().trim() || "Download Link";
          }
          
          if (!isJunkLink(cleanName)) {
            foundLinks.push({ name: cleanName.substring(0, 50), link: link });
          }
        }
      }
    });

    if (foundLinks.length === 0) {
      return { 
        status: "error", 
        message: `No links found. Page title: "${pageTitle}". entry-content: ${hasEntryContent}. Total anchors: ${totalAnchors}. The page structure might have changed or site is blocking.`
      };
    }

    return { 
      status: "success", 
      total: foundLinks.length, 
      links: foundLinks, 
      metadata,
      preview
    };

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

// =============================================================================
// MOVIE METADATA EXTRACTOR
// =============================================================================

export function extractMovieMetadata(html: string): {
  quality: string;
  languages: string;
  audioLabel: string;
} {
  const $ = cheerio.load(html);

  const validLangs = [
    'Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam',
    'Kannada', 'Punjabi', 'Marathi', 'Bengali', 'Spanish',
    'French', 'Korean', 'Japanese', 'Chinese'
  ];

  const foundLanguages = new Set<string>();
  const qualityInfo = { resolution: '', format: '' };

  const formatPriority: Record<string, number> = {
    'WEB-DL': 5, 'BluRay': 4, 'WEBRip': 3, 'HEVC': 2, 'x264': 1, 'HDTC': 0, '10Bit': 0
  };

  let $mainContent: any = $('main.page-body');
  if ($mainContent.length === 0) $mainContent = $('div.entry-content');
  if ($mainContent.length === 0) $mainContent = $.root();

  let $downloadSection: ReturnType<typeof $> | null = null;
  $mainContent.find('h2, h3, h4').each((_i: number, heading: any) => {
    const headingText = $(heading).text().toUpperCase();
    if (headingText.includes('DOWNLOAD LINKS')) {
      $downloadSection = $(heading).parent();
      return false;
    }
  });
  if (!$downloadSection) $downloadSection = $mainContent;

  const downloadLinks = ($downloadSection as ReturnType<typeof $>).find('a[href]');

  downloadLinks.each((_i, el) => {
    const href = $(el).attr('href') || '';
    const cdnDomains = ['hubcdn', 'hubdrive', 'gadgetsweb', 'hubstream', 'hdstream', 'hblinks', 'hubcloud', 'gdflix', 'drivehub'];
    if (!cdnDomains.some(d => href.toLowerCase().includes(d))) return;

    const $parent = $(el).closest('h3, h4, p');
    const buttonLabel = $parent.length ? $parent.text().trim() : $(el).text().trim();

    for (const lang of validLangs) {
      const regex = new RegExp(`\\b${lang}\\b`, 'i');
      if (regex.test(buttonLabel)) {
        foundLanguages.add(lang);
      }
    }

    const resPatterns: [RegExp, string][] = [
      [/2160p|4K/i, '2160P'],
      [/1080p/i, '1080P'],
      [/720p/i, '720P'],
      [/480p/i, '480P'],
    ];

    for (const [pattern, label] of resPatterns) {
      if (pattern.test(buttonLabel)) {
        if (!qualityInfo.resolution) {
          qualityInfo.resolution = label;
        }
        break;
      }
    }

    const formatPatterns: [RegExp, string][] = [
      [/WEB-DL/i, 'WEB-DL'], [/BLURAY|BLU-RAY/i, 'BluRay'], [/WEBRIP|WEB-RIP/i, 'WEBRip'],
      [/HDTC|HD-TC/i, 'HDTC'], [/HEVC|H\.265|x265/i, 'HEVC'], [/x264|H\.264/i, 'x264'],
      [/10[- ]?Bit/i, '10Bit'],
    ];

    for (const [pattern, formatName] of formatPatterns) {
      if (pattern.test(buttonLabel)) {
        const currentPriority = formatPriority[qualityInfo.format] ?? -1;
        const newPriority = formatPriority[formatName] ?? -1;
        if (newPriority > currentPriority) {
          qualityInfo.format = formatName;
        }
        break;
      }
    }
  });

  const pageText = ($downloadSection as ReturnType<typeof $>).text();
  const multiMatch = pageText.match(/MULTi[\s\S]*?\[([\s\S]*?HINDI[\s\S]*?)\]/i);
  if (multiMatch) {
    const langString = multiMatch[1];
    for (const lang of validLangs) {
      const regex = new RegExp(`\\b${lang}\\b`, 'i');
      if (regex.test(langString)) {
        foundLanguages.add(lang);
      }
    }
  }

  if (foundLanguages.size === 0) {
    $mainContent.find('div, span, p').each((_i: number, elem: any) => {
      const text = $(elem).text();
      const langFieldMatch = text.match(/Language\s*:(.+?)(?:\n|\/|$)/i);
      if (langFieldMatch) {
        const langLine = langFieldMatch[1];
        for (const lang of validLangs) {
          const regex = new RegExp(`\\b${lang}\\b`, 'i');
          if (regex.test(langLine)) {
            foundLanguages.add(lang);
          }
        }
        return false;
      }
    });
  }

  if (!qualityInfo.resolution) {
    $mainContent.find('div, span, p').each((_i: number, elem: any) => {
      const text = $(elem).text();
      if (/Quality\s*:/i.test(text)) {
        const qualityMatch = text.match(/Quality\s*:(.+?)(?:\n|$)/i);
        if (qualityMatch) {
          const qualityLine = qualityMatch[1];
          const resMatch = qualityLine.match(/(480p|720p|1080p|2160p|4K)/i);
          if (resMatch) {
            qualityInfo.resolution = resMatch[1].toUpperCase();
          }
          const fallbackFormatPatterns: [RegExp, string][] = [
            [/WEB-DL/i, 'WEB-DL'], [/BLURAY|BLU-RAY/i, 'BluRay'], [/WEBRIP|WEB-RIP/i, 'WEBRip'],
            [/HDTC|HD-TC/i, 'HDTC'], [/HEVC|H\.265|x265/i, 'HEVC'], [/x264|H\.264/i, 'x264'],
          ];
          for (const [pattern, formatName] of fallbackFormatPatterns) {
            if (pattern.test(qualityLine)) {
              qualityInfo.format = formatName;
              break;
            }
          }
        }
        return false;
      }
    });
  }

  const langList = Array.from(foundLanguages).sort();
  const count = langList.length;

  let audioLabel = 'Not Found';
  if (count === 1) audioLabel = langList[0];
  else if (count === 2) audioLabel = 'Dual Audio';
  else if (count >= 3) audioLabel = 'Multi Audio';

  let finalQuality = 'Unknown Quality';
  if (qualityInfo.resolution) {
    finalQuality = `${qualityInfo.resolution} ${qualityInfo.format}`.trim();
  }

  return {
    quality: finalQuality,
    languages: langList.length > 0 ? langList.join(', ') : 'Not Specified',
    audioLabel: audioLabel
  };
}

// =============================================================================
// HUBCDN SOLVER — WITH SMART TIMEOUT
// =============================================================================

/**
 * ✅ SMART TIMEOUT: max 12s per step, budget aware
 */
export async function solveHubCDN(url: string, budget?: GlobalTimeoutBudget) {
  const headers = { ...MOBILE_HEADERS };

  try {
    if (budget?.isExpired) {
      return { status: "error", message: "⏱️ Budget expired before HubCDN" };
    }

    let targetUrl = url;

    if (!url.includes("/dl/")) {
      const axiosConfig = getAxiosConfig(API_TIMEOUTS.HUBCDN, budget, { headers });
      try {
        const resp = await axios.get(url, {
          headers,
          timeout: axiosConfig.timeout,
          signal: axiosConfig.signal,
        });
        const html = resp.data;
        
        const reurlMatch = html.match(/var reurl = "(.*?)"/);
        if (reurlMatch) {
          const cleanRedirectUrl = reurlMatch[1].replace(/&amp;/g, '&');
          const urlObj = new URL(cleanRedirectUrl);
          const rParam = urlObj.searchParams.get('r');
          
          if (rParam) {
            const paddedB64 = rParam + "=".repeat((4 - rParam.length % 4) % 4);
            targetUrl = Buffer.from(paddedB64, 'base64').toString('utf-8');
          }
        }
      } finally {
        clearTimeout(axiosConfig._cleanupTimer);
      }
    }

    // Step 2: Get final download link
    if (budget?.isExpired) {
      return { status: "error", message: "⏱️ Budget expired before HubCDN step 2" };
    }

    const axiosConfig2 = getAxiosConfig(API_TIMEOUTS.HUBCDN, budget, { headers });
    try {
      const finalResp = await axios.get(targetUrl, {
        headers,
        timeout: axiosConfig2.timeout,
        signal: axiosConfig2.signal,
      });
      const $ = cheerio.load(finalResp.data);
      
      const linkTag = $('a#vd');
      const finalLink = linkTag.attr('href');

      if (finalLink) {
        return { status: "success", final_link: finalLink };
      }

      const scriptMatch = finalResp.data.match(/window\.location\.href\s*=\s*"(.*?)"/);
      if (scriptMatch) {
        return { status: "success", final_link: scriptMatch[1] };
      }

      return { status: "failed", message: "Link id='vd' not found in HTML" };
    } finally {
      clearTimeout(axiosConfig2._cleanupTimer);
    }

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

// =============================================================================
// HUBDRIVE SOLVER — WITH SMART TIMEOUT
// =============================================================================

/**
 * ✅ SMART TIMEOUT: max 10s, budget aware
 */
export async function solveHubDrive(url: string, budget?: GlobalTimeoutBudget) {
  try {
    if (budget?.isExpired) {
      return { status: "error", message: "⏱️ Budget expired before HubDrive" };
    }

    const axiosConfig = getAxiosConfig(API_TIMEOUTS.HUBDRIVE, budget, { headers: BROWSER_HEADERS });
    try {
      const response = await axios.get(url, {
        headers: BROWSER_HEADERS,
        timeout: axiosConfig.timeout,
        signal: axiosConfig.signal,
      });
      const $ = cheerio.load(response.data);

      let finalLink = "";

      const btnSuccess = $('a.btn-success[href*="hubcloud"]');
      if (btnSuccess.length > 0) {
        finalLink = btnSuccess.attr('href') || "";
      }

      if (!finalLink) {
        const dlBtn = $('a#dl');
        if (dlBtn.length > 0) {
          finalLink = dlBtn.attr('href') || "";
        }
      }

      if (!finalLink) {
        $('a[href]').each((_i: number, el: any) => {
          const href = $(el).attr('href') || "";
          if (href.includes('hubcloud') || href.includes('hubcdn')) {
            finalLink = href;
            return false;
          }
        });
      }

      if (finalLink) {
        return { status: "success", link: finalLink };
      }

      return { status: "fail", message: "Download link not found on HubDrive page" };
    } finally {
      clearTimeout(axiosConfig._cleanupTimer);
    }

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

// =============================================================================
// HUBCLOUD SOLVER — API DRIVEN — WITH SMART TIMEOUT
// =============================================================================

interface HubCloudButton {
  button_name: string;
  download_link: string;
}

export interface HubCloudNativeResult {
  status: 'success' | 'error';
  best_button_name?: string;
  best_download_link?: string;
  all_available_buttons?: HubCloudButton[];
  message?: string;
}

/**
 * ✅ SMART TIMEOUT: max 20s for the Python API call, budget aware
 */
export async function solveHubCloudNative(
  url: string,
  budget?: GlobalTimeoutBudget
): Promise<HubCloudNativeResult> {
  const apiBase = "http://127.0.0.1:5000/solve?url=";

  console.log(`[HubCloud] 🚀 Starting API Solver: ${url} ${budget?.getStatus() || ''}`);

  if (budget?.isExpired) {
    return { status: 'error', message: '⏱️ Budget expired before HubCloud API' };
  }

  try {
    const apiUrl = apiBase + encodeURIComponent(url);
    console.log(`[HubCloud API] 🌐 Calling localhost:5000...`);

    const axiosConfig = getAxiosConfig(API_TIMEOUTS.HUBCLOUD_API, budget, {
      headers: { 'User-Agent': 'MflixPro/1.0' },
    });

    try {
      const resp = await axios.get(apiUrl, {
        timeout: axiosConfig.timeout,
        signal: axiosConfig.signal,
        headers: { 'User-Agent': 'MflixPro/1.0' },
      });

      const data = resp.data;

      if (data.status === 'success' && data.best_download_link) {
        console.log(`[HubCloud API] ✅ Success: ${data.best_button_name}`);
        return {
          status: 'success',
          best_button_name: data.best_button_name || undefined,
          best_download_link: data.best_download_link,
          all_available_buttons: data.all_available_buttons || [],
        };
      }

      console.log(`[HubCloud API] ❌ Failed: ${data.message || 'unknown'}`);
      return { status: 'error', message: data.message || 'No download link from API' };
    } finally {
      clearTimeout(axiosConfig._cleanupTimer);
    }

  } catch (e: any) {
    console.error(`[HubCloud API] ❌ Error: ${e.message}`);
    return { status: 'error', message: `API error: ${e.message}` };
  }
}
