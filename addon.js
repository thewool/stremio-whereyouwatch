const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// --- NEW: OMDB API KEY ---
// Get a free key at https://www.omdbapi.com/apikey.aspx
const OMDB_API_KEY = ''; // <--- PASTE YOUR KEY HERE

// INCREASED LIMITS: 
// 120 days (approx 4 months) to ensure we get 300 items even if they are old
const MAX_AGE_MS = 120 * 24 * 60 * 60 * 1000; 
const MAX_ITEMS = 300;

const manifest = {
    id: 'org.whereyouwatch.reports',
    version: '1.0.7', 
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

function parseDate(dateString) {
    if (!dateString) return Date.now();
    const cleanDate = dateString.replace('Submitted on:', '').trim();
    return new Date(cleanDate).getTime();
}

// --- NEW: Helper to fetch RT Rating ---
async function getRtRating(imdbId) {
    if (!OMDB_API_KEY) return null;
    try {
        // We use a short timeout so we don't slow down the scrape too much
        const { data } = await axios.get(`http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbId}&tomatoes=true`, { timeout: 3000 });
        if (data && data.Ratings) {
            const rt = data.Ratings.find(r => r.Source === 'Rotten Tomatoes');
            return rt ? rt.Value : null;
        }
    } catch (e) {
        // Silently fail if OMDB is down or quota exceeded
        return null;
    }
    return null;
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
            // Stop if we have enough items
            if (allItems.length >= MAX_ITEMS) {
                console.log(`> Reached target of ${MAX_ITEMS} items. Stopping.`);
                break;
            }

            console.log(`> Fetching Page ${page}... (Current Count: ${allItems.length})`);
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
                let itemsFoundOnPage = 0;

                $('.jrResourceTitle').each((i, el) => {
                    if (allItems.length >= MAX_ITEMS) {
                        keepFetching = false;
                        return false; 
                    }

                    const rawTitle = $(el).text().trim();
                    const hasYear = /\b(19|20)\d{2}\b/.test(rawTitle);
                    const hasQuality = /WEB|1080p|2160p|DVDRip|BluRay|HDRip|H\.264|H\.265/i.test(rawTitle);

                    if (hasYear && hasQuality) {
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
                
                if (keepFetching) await delay(1500); 
                
                if (page > 35) {
                    keepFetching = false;
                }

            } catch (err) {
                console.error(`Error fetching page ${page}: ${err.message}`);
                keepFetching = false;
            }
        }

        console.log(`> Found ${allItems.length} reports. Matching IMDb & RT...`);
        lastStatus = `Processing ${allItems.length} items (Fetching Ratings)...`;
        const newCatalog = [];

        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);

            if (imdbItem) {
                // --- NEW: Fetch RT Rating and Append ---
                let displayName = imdbItem.name;
                const rtRating = await getRtRating(imdbItem.id);
                
                if (rtRating) {
                    displayName = `${imdbItem.name} ${rtRating}`;
                }
                // ----------------------------------------

                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: displayName, // Use the new name with suffix
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `Release: ${item.rawTitle}\nMatched: ${imdbItem.name}\nRotten Tomatoes: ${rtRating || 'N/A'}`,
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
