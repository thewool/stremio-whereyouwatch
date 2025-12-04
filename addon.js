const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// SETTINGS
const TARGET_PAGE_COUNT = 15; // Scrape 15 pages
const MAX_ITEMS = 300;

const manifest = {
    id: 'org.whereyouwatch.reports',
    version: '1.0.9', 
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
        // Clean up common suffix junk often found in raw text
        title = title.replace(/Submitted on:/i, '').trim();
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
    console.log('--- STARTING DEEP SCAN SCRAPE ---');
    lastStatus = "Scraping...";
    let allItems = [];
    let page = 1;

    try {
        while (page <= TARGET_PAGE_COUNT) {
            if (allItems.length >= MAX_ITEMS) break;

            console.log(`> Fetching Page ${page}... (Current Total: ${allItems.length})`);
            const url = page === 1 ? BASE_URL : `${BASE_URL}page/${page}/`;
            
            try {
                const response = await axios.get(url, { 
                    headers: { 'User-Agent': USER_AGENT } 
                });
                
                const $ = cheerio.load(response.data);
                let itemsFoundOnPage = 0;

                // --- DEEP SCAN STRATEGY ---
                // Select ALL elements that might contain text
                $('div, span, strong, b, h1, h2, h3, h4, a, td').each((i, el) => {
                    // Only look at "Leaf Nodes" (elements with no children) to avoid duplicates
                    if ($(el).children().length > 0) return;

                    const rawTitle = $(el).text().trim();
                    
                    // Filter: Must look like a movie title with a Year
                    const hasYear = /\b(19|20)\d{2}\b/.test(rawTitle);
                    const isLongEnough = rawTitle.length > 5 && rawTitle.length < 100; // avoid huge paragraphs
                    const notMetadata = !rawTitle.includes("Submitted on") && !rawTitle.includes("Written by");

                    if (hasYear && isLongEnough && notMetadata) {
                        const alreadyAdded = allItems.some(item => item.rawTitle === rawTitle);
                        if (!alreadyAdded) {
                            itemsFoundOnPage++;
                            allItems.push({ rawTitle: rawTitle });
                        }
                    }
                });

                console.log(`> Page ${page}: Found ${itemsFoundOnPage} candidates.`);

            } catch (err) {
                console.error(`Error fetching page ${page}: ${err.message}`);
            }

            page++;
            await delay(1500); 
        }

        console.log(`> Found ${allItems.length} raw items. Matching IMDb...`);
        lastStatus = `Processing ${allItems.length} items...`;
        const newCatalog = [];

        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            
            // Skip bad parses
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
                // Limit unmatched items to avoid cluttering the catalog with garbage text
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


