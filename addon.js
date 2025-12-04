const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
// CHANGED: Switched to root URL to ensure pagination works
const BASE_URL = 'https://whereyouwatch.com/'; 
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// SETTINGS
const TARGET_PAGE_COUNT = 25; // Scrape 25 pages to ensure we get 300+ items
const MAX_ITEMS = 300;

const manifest = {
    id: 'org.whereyouwatch.reports',
    version: '1.1.0', 
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
        // Clean up common suffix junk
        title = title.replace(/Submitted on:/i, '').replace(/Posted by:/i, '').trim();
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
    console.log('--- STARTING HOMEPAGE FEED SCRAPE ---');
    lastStatus = "Scraping...";
    let allItems = [];
    let page = 1;

    try {
        while (page <= TARGET_PAGE_COUNT) {
            if (allItems.length >= MAX_ITEMS) break;

            console.log(`> Fetching Page ${page}... (Current Total: ${allItems.length})`);
            // Standard WordPress pagination pattern on the homepage
            const url = page === 1 ? BASE_URL : `${BASE_URL}page/${page}/`;
            
            try {
                const response = await axios.get(url, { 
                    headers: { 'User-Agent': USER_AGENT } 
                });
                
                const $ = cheerio.load(response.data);
                let itemsFoundOnPage = 0;

                // --- SMART BLOCK SCANNER ---
                // Instead of looking for titles directly, we look for "Article" or "Entry" containers
                // Common WP classes: .post, .article, .entry, .type-post
                $('.post, article, .entry, .type-post, .jrListing').each((i, el) => {
                    if (allItems.length >= MAX_ITEMS) return false;

                    // Get the FULL text of the card (Title + Date + Desc)
                    // This fixes issues where "Movie Name" and "2024" are in different divs
                    const fullText = $(el).text().replace(/\s+/g, ' ').trim();
                    
                    // We need to extract the title line specifically if possible
                    // Usually the title is in an h2, h3 or h4 tag inside the card
                    let titleText = $(el).find('h1, h2, h3, h4, .jrResourceTitle, .entry-title').first().text().trim();
                    
                    // Fallback: If no heading found, use the full text but truncate it
                    if (!titleText) titleText = fullText.substring(0, 100);

                    // Check if it's a valid movie release (Must have Year)
                    const hasYear = /\b(19|20)\d{2}\b/.test(titleText) || /\b(19|20)\d{2}\b/.test(fullText);
                    
                    if (hasYear) {
                        // If the Heading didn't have the year, but the body did, grab the body text
                        // but prefer the heading for cleaner titles
                        const rawTitle = /\b(19|20)\d{2}\b/.test(titleText) ? titleText : fullText.substring(0, 100);

                        const alreadyAdded = allItems.some(item => item.rawTitle === rawTitle);
                        if (!alreadyAdded) {
                            itemsFoundOnPage++;
                            allItems.push({ rawTitle: rawTitle });
                        }
                    }
                });

                // Fallback: If generic containers failed, try the old "Link Scan" but on the homepage
                if (itemsFoundOnPage === 0) {
                     $('a').each((i, el) => {
                        const txt = $(el).text().trim();
                        if (/\b(19|20)\d{2}\b/.test(txt) && txt.length > 5 && txt.length < 100) {
                            const alreadyAdded = allItems.some(item => item.rawTitle === txt);
                            if (!alreadyAdded) {
                                itemsFoundOnPage++;
                                allItems.push({ rawTitle: txt });
                            }
                        }
                     });
                }

                console.log(`> Page ${page}: Found ${itemsFoundOnPage} items.`);

            } catch (err) {
                console.error(`Error fetching page ${page}: ${err.message}`);
                // If 404, we likely reached the end of pagination
                if (err.response && err.response.status === 404) {
                    console.log("> Reached end of content (404). Stopping.");
                    break;
                }
            }

            page++;
            await delay(1500); 
        }

        console.log(`> Found ${allItems.length} raw items. Matching IMDb...`);
        lastStatus = `Processing ${allItems.length} items...`;
        const newCatalog = [];

        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            
            // Skip invalid junk
            if (!parsed.title || parsed.title.length < 2) continue;
            if (parsed.title.includes("Search") || parsed.title.includes("Menu")) continue;

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
                // Keep unmatched items but limited count
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


