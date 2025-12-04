const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// SETTINGS
const TARGET_PAGE_COUNT = 15; // FORCE scraper to read this many pages

const manifest = {
    id: 'org.whereyouwatch.reports',
    version: '1.0.8', 
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
    console.log('--- STARTING SCRAPE (WhereYouWatch) - FORCED MODE ---');
    lastStatus = "Scraping...";
    let allItems = [];
    let page = 1;

    try {
        // FORCE loop to run for TARGET_PAGE_COUNT, ignoring errors or empty pages
        while (page <= TARGET_PAGE_COUNT) {
            console.log(`> Fetching Page ${page}... (Current Total: ${allItems.length})`);
            const url = page === 1 ? BASE_URL : `${BASE_URL}page/${page}/`;
            
            try {
                const response = await axios.get(url, { 
                    headers: { 'User-Agent': USER_AGENT } 
                });
                
                const $ = cheerio.load(response.data);
                let itemsFoundOnPage = 0;

                // AGGRESSIVE SELECTOR: jrResourceTitle is the specific one, others are fallbacks
                $('.jrResourceTitle, .jrListingTitle, td strong').each((i, el) => {
                    const rawTitle = $(el).text().trim();
                    
                    // Simple Validation: Must contain a year
                    const hasYear = /\b(19|20)\d{2}\b/.test(rawTitle);
                    const isLongEnough = rawTitle.length > 5;

                    if (hasYear && isLongEnough) {
                        const alreadyAdded = allItems.some(item => item.rawTitle === rawTitle);
                        if (!alreadyAdded) {
                            itemsFoundOnPage++;
                            // We aren't filtering by date anymore to ensure we get results
                            allItems.push({ rawTitle: rawTitle });
                        }
                    }
                });

                console.log(`> Page ${page}: Found ${itemsFoundOnPage} items.`);

                // removed the "if items == 0 then stop" logic. 
                // We keep going just in case Page 2 is weird but Page 3 is fine.

            } catch (err) {
                console.error(`Error fetching page ${page}: ${err.message}`);
                // Don't stop on error, just try next page
            }

            page++;
            await delay(1000); // 1 second pause between pages
        }

        console.log(`> Found ${allItems.length} reports total. Matching IMDb...`);
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


