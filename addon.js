const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// SETTINGS
const MAX_ITEMS = 300; 
const TARGET_PAGE_COUNT = 30; // 30 pages * ~10 items = ~300 items

const manifest = {
    id: 'org.whereyouwatch.reports',
    version: '1.1.2', 
    name: 'WhereYouWatch Reports',
    description: 'Latest releases from WhereYouWatch.com',
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
        // Clean common prefixes/suffixes
        title = title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
        return { title: title, year: yearMatch[0] };
    }
    return { title: rawString, year: null };
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
    console.log('--- STARTING SCRAPE (Correct ?pg= Pagination) ---');
    lastStatus = "Scraping...";
    let allItems = [];
    let page = 1;

    try {
        while (page <= TARGET_PAGE_COUNT) {
            if (allItems.length >= MAX_ITEMS) break;

            // CORRECTED URL CONSTRUCTION
            // Page 1: https://whereyouwatch.com/latest-reports/
            // Page 2: https://whereyouwatch.com/latest-reports/?pg=2
            const url = page === 1 ? BASE_URL : `${BASE_URL}?pg=${page}`;
            
            console.log(`> Fetching Page ${page} [${url}]... (Total: ${allItems.length})`);

            try {
                const response = await axios.get(url, { 
                    headers: { 'User-Agent': USER_AGENT } 
                });
                
                const $ = cheerio.load(response.data);
                let itemsFoundOnPage = 0;

                // Selectors:
                // .jrResourceTitle -> Featured/Top items
                // .jrListingTitle -> Standard list items
                // h2 a, h3 a -> General fallback
                const candidates = $('.jrResourceTitle, .jrListingTitle, h2 a, h3 a, .entry-title');

                candidates.each((i, el) => {
                    if (allItems.length >= MAX_ITEMS) return false;

                    const rawTitle = $(el).text().trim();
                    const href = $(el).attr('href') || $(el).parent().attr('href');

                    // Validation: Must have Year
                    const hasYear = /\b(19|20)\d{2}\b/.test(rawTitle);
                    const isJunk = rawTitle.includes("Guide") || rawTitle.includes("Register") || rawTitle.includes("Login");

                    if (hasYear && !isJunk) {
                        const alreadyAdded = allItems.some(item => item.rawTitle === rawTitle);
                        if (!alreadyAdded) {
                            itemsFoundOnPage++;
                            allItems.push({ rawTitle: rawTitle, link: href });
                        }
                    }
                });

                console.log(`> Page ${page}: Found ${itemsFoundOnPage} items.`);

                // If a page returns 0 items, it might be the end of the list, or just a bad page.
                // We'll give it 2 "strikes" before quitting.
                if (itemsFoundOnPage === 0 && page > 1) {
                     // Check if we are truly at the end (often redirect to home or 404)
                     if (response.request.res.responseUrl && !response.request.res.responseUrl.includes('pg=')) {
                        console.log("> Redirected to homepage. End of pagination.");
                        break;
                     }
                }

            } catch (err) {
                console.error(`Error fetching page ${page}: ${err.message}`);
                // 404 usually means end of pagination
                if (err.response && err.response.status === 404) {
                    console.log("> Reached 404. Stopping.");
                    break;
                }
            }

            page++;
            await delay(1200); // Respectful delay
        }

        console.log(`> Found ${allItems.length} raw items. Matching IMDb...`);
        lastStatus = `Processing ${allItems.length} items...`;
        const newCatalog = [];

        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            
            if (!parsed.title || parsed.title.length < 2) continue;
            
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
                if (newCatalog.length < 300) {
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
        }

        // Deduplicate
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
                description: "The addon is currently fetching data. Please wait.",
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
setInterval(scrapePages, 180 * 60 * 1000); 
console.log(`Addon running on http://localhost:${PORT}`);


