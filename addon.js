const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const OMDB_API_KEY = 'a8924bd9'; // <--- GET FREE KEY AT omdbapi.com
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// SETTINGS
const MAX_ITEMS = 300; 
const TARGET_PAGE_COUNT = 30; 

const manifest = {
    id: 'org.whereyouwatch.reports.rt',
    version: '1.2.0', 
    name: 'WhereYouWatch + Rotten Tomatoes',
    description: 'Latest releases with RT Scores',
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'wyw_reports_rt',
            name: 'WhereYouWatch RT',
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

// Helper to fetch RT Score from OMDB
async function getRtScore(imdbId) {
    if (!OMDB_API_KEY || OMDB_API_KEY === 'YOUR_OMDB_KEY_HERE') return null;
    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbId}`;
        const { data } = await axios.get(url);
        
        if (data && data.Ratings) {
            const rt = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
            return rt ? rt.Value : null;
        }
    } catch (e) {
        // Silent fail on rating fetch to keep process moving
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
    console.log('--- STARTING SCRAPE WITH RT SCORES ---');
    lastStatus = "Scraping & Rating...";
    let allItems = [];
    let page = 1;

    try {
        while (page <= TARGET_PAGE_COUNT) {
            if (allItems.length >= MAX_ITEMS) break;

            const url = page === 1 ? BASE_URL : `${BASE_URL}?pg=${page}`;
            console.log(`> Fetching Page ${page} [${url}]...`);

            try {
                const response = await axios.get(url, { 
                    headers: { 'User-Agent': USER_AGENT } 
                });
                
                const $ = cheerio.load(response.data);
                let itemsFoundOnPage = 0;

                const candidates = $('.jrResourceTitle, .jrListingTitle, h2 a, h3 a, .entry-title');

                candidates.each((i, el) => {
                    if (allItems.length >= MAX_ITEMS) return false;

                    const rawTitle = $(el).text().trim();
                    const href = $(el).attr('href') || $(el).parent().attr('href');
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

                if (itemsFoundOnPage === 0 && page > 1) {
                      if (response.request.res.responseUrl && !response.request.res.responseUrl.includes('pg=')) {
                        break;
                      }
                }

            } catch (err) {
                if (err.response && err.response.status === 404) break;
            }

            page++;
            await delay(1000); // 1 second delay between pages
        }

        console.log(`> Found ${allItems.length} items. Fetching Metadata & RT Scores...`);
        lastStatus = `Processing ${allItems.length} items...`;
        const newCatalog = [];

        // Loop through items to resolve IMDb + RT Score
        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            
            if (!parsed.title || parsed.title.length < 2) continue;
            
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);

            if (imdbItem) {
                // Fetch RT Score here
                const rtScore = await getRtScore(imdbItem.id);
                const scorePrefix = rtScore ? `🍅 ${rtScore} ` : '';

                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: `${scorePrefix}${imdbItem.name}`, // Add Score to Name
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `Rotten Tomatoes: ${rtScore || 'N/A'}\nRelease: ${item.rawTitle}`,
                    releaseInfo: imdbItem.releaseInfo
                });
            } else {
                // Fallback for unmatched items
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
            // Small delay to prevent hitting OMDB rate limits too hard
            await delay(100); 
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
                description: "The addon is currently fetching data and scores. Please wait.",
                poster: 'https://via.placeholder.com/300x450.png?text=Loading...',
            }]
        };
    }
    if (type === 'movie' && id === 'wyw_reports_rt') {
        const skip = extra.skip ? parseInt(extra.skip) : 0;
        return { metas: movieCatalog.slice(skip, skip + 100) };
    }
    return { metas: [] };
});

serveHTTP(builder.getInterface(), { port: PORT });
scrapePages();
setInterval(scrapePages, 180 * 60 * 1000); 
console.log(`Addon running on http://localhost:${PORT}`);
