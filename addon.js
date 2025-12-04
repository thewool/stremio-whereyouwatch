const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const START_URL = 'https://whereyouwatch.com/latest-reports/'; 
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// SETTINGS
const MAX_ITEMS = 300; // Target catalog size

const manifest = {
    id: 'org.whereyouwatch.reports',
    version: '1.1.1', 
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
    console.log('--- STARTING SCRAPE (Smart Pagination) ---');
    lastStatus = "Scraping...";
    let allItems = [];
    let nextUrl = START_URL;
    let pageCount = 1;

    try {
        while (nextUrl && allItems.length < MAX_ITEMS && pageCount <= 25) {
            console.log(`> Fetching Page ${pageCount} [${nextUrl}]... (Total: ${allItems.length})`);
            
            try {
                const response = await axios.get(nextUrl, { 
                    headers: { 'User-Agent': USER_AGENT } 
                });
                
                const $ = cheerio.load(response.data);
                let itemsFoundOnPage = 0;

                // 1. SELECTOR STRATEGY
                // We search for multiple common classes.
                // .jrResourceTitle = Featured items (usually top 5)
                // .jrListingTitle = Standard items (the long list)
                // .entry-title = Generic fallback
                const candidates = $('.jrResourceTitle, .jrListingTitle, .entry-title, h2 a, h3 a');

                candidates.each((i, el) => {
                    if (allItems.length >= MAX_ITEMS) return false;

                    const rawTitle = $(el).text().trim();
                    const href = $(el).attr('href') || $(el).parent().attr('href');

                    // Filter: Must have Year
                    const hasYear = /\b(19|20)\d{2}\b/.test(rawTitle);
                    // Filter: Must NOT be site metadata
                    const isJunk = rawTitle.includes("Guide") || rawTitle.includes("Register") || rawTitle.includes("Login");

                    if (hasYear && !isJunk) {
                        const alreadyAdded = allItems.some(item => item.rawTitle === rawTitle);
                        if (!alreadyAdded) {
                            itemsFoundOnPage++;
                            allItems.push({ rawTitle: rawTitle, link: href });
                        }
                    }
                });

                console.log(`> Page ${pageCount}: Found ${itemsFoundOnPage} items.`);

                // 2. PAGINATION STRATEGY
                // Find the "Next" button dynamically to ensure we get the right URL
                const nextLink = $('a.next, a.jr_next, a:contains("Next"), a:contains("›")').last();
                
                if (nextLink.length > 0) {
                    let nextHref = nextLink.attr('href');
                    // Handle relative URLs
                    if (nextHref && !nextHref.startsWith('http')) {
                        if (nextHref.startsWith('/')) {
                            nextUrl = 'https://whereyouwatch.com' + nextHref;
                        } else {
                            nextUrl = nextUrl.replace(/\/[^\/]*$/, '/') + nextHref;
                        }
                    } else {
                        nextUrl = nextHref;
                    }
                    console.log(`> Next Page detected: ${nextUrl}`);
                } else {
                    console.log("> No 'Next' button found. Attempting manual URL increment.");
                    // Fallback if button is hidden: try manual increment
                    nextUrl = `${START_URL}page/${pageCount + 1}/`;
                }

                // If page was empty, stop manual increment loop to prevent infinite 404s
                if (itemsFoundOnPage === 0 && pageCount > 1) {
                    console.log("> Empty page. Stopping.");
                    break;
                }

            } catch (err) {
                console.error(`Error fetching page ${pageCount}: ${err.message}`);
                break;
            }

            pageCount++;
            await delay(1500);
        }

        console.log(`> Found ${allItems.length} raw items. Matching IMDb...`);
        lastStatus = `Processing ${allItems.length} items...`;
        const newCatalog = [];

        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            
            // Validity Check
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


