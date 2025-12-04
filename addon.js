const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// 60 days in milliseconds
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; 

const manifest = {
    id: 'org.whereyouwatch.reports',
    version: '1.0.4', 
    name: 'WhereYouWatch Reports',
    description: 'Latest releases from WhereYouWatch.com (Last 2 Months)',
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'wyw_reports',
            name: 'WhereYouWatch',
            extra: [{ name: 'skip' }]
        }
    ]
};

const builder = new addonBuilder(manifest);
let movieCatalog = [];
let lastStatus = "Initializing...";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseReleaseTitle(rawString) {
    const yearMatch = rawString.match(/(19|20)\d{2}/);
    if (yearMatch) {
        const yearIndex = yearMatch.index;
        let title = rawString.substring(0, yearIndex).trim();
        title = title.replace(/\./g, ' ').replace(/_/g, ' ');
        return { title: title, year: yearMatch[0] };
    }
    return { title: rawString, year: null };
}

function parseDate(dateString) {
    if (!dateString) return Date.now();
    const cleanDate = dateString.replace('Submitted on:', '').trim();
    return new Date(cleanDate).getTime();
}

async function resolveToImdb(title, year) {
    if (!year) return null;
    try {
        const query = `${title} ${year}`;
        const url = `${CINEMETA_URL}/search=${encodeURIComponent(query)}.json`;
        const { data } = await axios.get(url);
        if (data && data.metas && data.metas.length > 0) {
            return data.metas[0];
        }
    } catch (e) { return null; }
    return null;
}

async function scrapePages() {
    console.log('--- STARTING SCRAPE (WhereYouWatch) ---');
    lastStatus = "Scraping Page 1...";
    let allItems = [];
    let keepFetching = true;
    let page = 1;
    const cutoffDate = Date.now() - MAX_AGE_MS;

    try {
        while (keepFetching) {
            console.log(`> Fetching Page ${page}...`);
            const url = page === 1 ? BASE_URL : `${BASE_URL}page/${page}/`;
            try {
                const response = await axios.get(url, { 
                    headers: { 
                        'User-Agent': USER_AGENT,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9'
                    } 
                });
                
                const $ = cheerio.load(response.data);
                
                // --- DIAGNOSTIC MODE ---
                if (page === 1) {
                    const html = response.data;
                    const has1080p = html.includes('1080p');
                    const has2024 = html.includes('2024') || html.includes('2025');

                    console.log(`> [DEBUG] HTML Check: Contains '1080p'? ${has1080p}`);
                    console.log(`> [DEBUG] HTML Check: Contains '2024/2025'? ${has2024}`);

                    if (!has1080p && !has2024) {
                        console.error("> [CRITICAL] Keywords missing. The site likely uses JavaScript to load content. Puppeteer may be required.");
                    } else if (has1080p) {
                        console.log("> [DEBUG] Finding element containing '1080p'...");
                        // Find the deepest element containing "1080p"
                        $('*').each((i, el) => {
                            if ($(el).children().length === 0 && $(el).text().includes('1080p')) {
                                console.log(`> [DEBUG] MAGIC TRACER (Tag): <${el.tagName}>`);
                                console.log(`> [DEBUG] MAGIC TRACER (Class): "${$(el).attr('class')}"`);
                                console.log(`> [DEBUG] MAGIC TRACER (Text): "${$(el).text().substring(0, 100)}..."`);
                                console.log(`> [DEBUG] MAGIC TRACER (Parent): <${$(el).parent().get(0).tagName}> class="${$(el).parent().attr('class')}"`);
                                return false; // Stop after first match
                            }
                        });
                    }

                    // Dump ANY link that has a year, regardless of quality
                    let debugYearCount = 0;
                    $('a').each((i, el) => {
                        const txt = $(el).text().trim();
                        if (/\b(19|20)\d{2}\b/.test(txt) && debugYearCount < 5) {
                            console.log(`> [DEBUG] Potential Movie Link: "${txt}"`);
                            debugYearCount++;
                        }
                    });
                }
                // -----------------------

                let itemsFoundOnPage = 0;

                // Broadened selector: Try finding ANY element with the quality patterns if 'a' tags fail
                // For now, stick to 'a' but log if we are failing
                $('a').each((i, el) => {
                    const rawTitle = $(el).text().trim();
                    
                    const hasYear = /\b(19|20)\d{2}\b/.test(rawTitle);
                    // Standard scene release patterns
                    const hasQuality = /WEB|1080p|2160p|DVDRip|BluRay|HDRip|H\.264|H\.265/i.test(rawTitle);

                    if (hasYear && hasQuality) {
                        // ... existing date logic ...
                        let container = $(el).parent();
                        let dateText = null;
                        
                        for (let k = 0; k < 4; k++) {
                            const textToCheck = container.text();
                            const match = textToCheck.match(/Submitted on:\s*([A-Za-z]+\s\d{1,2},\s\d{4})/);
                            if (match) { dateText = match; break; }
                            
                            const siblingMatch = container.nextAll().text().match(/Submitted on:\s*([A-Za-z]+\s\d{1,2},\s\d{4})/);
                            if (siblingMatch) { dateText = siblingMatch; break; }

                            container = container.parent();
                        }
                        
                        if (!dateText) {
                             const nearHtml = $(el).parent().html() || "";
                             dateText = nearHtml.match(/([A-Za-z]{3}\s\d{1,2},\s\d{4})/);
                        }

                        if (dateText) {
                            const dateStr = Array.isArray(dateText) ? dateText[1] : dateText;
                            const dateTs = parseDate(dateStr);
                            
                            const alreadyAdded = allItems.some(item => item.rawTitle === rawTitle);
                            if (!alreadyAdded) {
                                if (dateTs < cutoffDate) {
                                    keepFetching = false;
                                    return false; 
                                }
                                itemsFoundOnPage++;
                                allItems.push({ rawTitle: rawTitle, date: dateTs });
                            }
                        }
                    }
                });

                console.log(`> Page ${page}: Found ${itemsFoundOnPage} valid items.`);

                if (itemsFoundOnPage === 0 && page > 1) keepFetching = false;
                page++;
                if (keepFetching) await delay(2000);
                if (page > 10) keepFetching = false;

            } catch (err) {
                console.error(`Error fetching page ${page}: ${err.message}`);
                keepFetching = false;
            }
        }

        console.log(`> Found ${allItems.length} reports. Matching IMDb...`);
        lastStatus = `Processing ${allItems.length} items...`;
        const newCatalog = [];

        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);

            if (imdbItem) {
                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: imdbItem.name,
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `Release: ${item.rawTitle}\nMatched: ${imdbItem.name}`,
                    releaseInfo: imdbItem.releaseInfo
                });
            } else {
                newCatalog.push({
                    id: `wyw_${parsed.title.replace(/\s/g, '')}_${parsed.year || '0000'}`,
                    type: 'movie',
                    name: parsed.title,
                    poster: null,
                    description: `Unmatched Release: ${item.rawTitle}`,
                    releaseInfo: parsed.year || '????'
                });
            }
        }

        const uniqueCatalog = [];
        const seenIds = new Set();
        for (const item of newCatalog) {
            if (!seenIds.has(item.id)) {
                seenIds.add(item.id);
                uniqueCatalog.push(item);
            }
        }

        movieCatalog = uniqueCatalog;
        lastStatus = "Ready";
        console.log(`> Update Complete. Catalog size: ${movieCatalog.length}`);

    } catch (error) {
        console.error('! Critical Error:', error.message);
        lastStatus = `Error: ${error.message}`;
    }
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (movieCatalog.length === 0) {
        return {
            metas: [{
                id: 'tt_status',
                type: 'movie',
                name: `Status: ${lastStatus}`,
                description: "Check Render logs to debug the scraper.",
                poster: 'https://via.placeholder.com/300x450.png?text=Loading...',
            }]
        };
    }
    if (type === 'movie' && id === 'wyw_reports') {
        const skip = extra.skip ? parseInt(extra.skip) : 0;
        return { metas: movieCatalog.slice(skip, skip + 100) };
    }
    return { metas: [] };
});

serveHTTP(builder.getInterface(), { port: PORT });
scrapePages();
setInterval(scrapePages, 120 * 60 * 1000); 
console.log(`Addon running on http://localhost:${PORT}`);
