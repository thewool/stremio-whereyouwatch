const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const OMDB_API_KEY = 'a8924bd9'; // <--- MUST BE VALID FREE KEY
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// SETTINGS
const MAX_ITEMS = 300; 
const TARGET_PAGE_COUNT = 30; 

const manifest = {
    id: 'org.whereyouwatch.reports.rt',
    version: '1.2.1', 
    name: 'WhereYouWatch + Ratings',
    description: 'Latest releases with RT/IMDb/Metacritic',
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
        title = title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
        return { title: title, year: yearMatch[0] };
    }
    return { title: rawString, year: null };
}

// Helper to fetch Scores from OMDB (RT -> Metacritic -> IMDb)
async function getRating(imdbId) {
    if (!OMDB_API_KEY || OMDB_API_KEY.includes('YOUR_OMDB')) return null;
    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbId}`;
        const { data } = await axios.get(url);
        
        if (!data) return null;

        // 1. Try Rotten Tomatoes
        if (data.Ratings) {
            const rt = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
            if (rt) return { type: 'RT', value: rt.Value };
        }

        // 2. Try Metacritic (Often updates faster than RT on free API)
        if (data.Metascore && data.Metascore !== "N/A") {
            return { type: 'Meta', value: data.Metascore };
        }

        // 3. Fallback to IMDb
        if (data.imdbRating && data.imdbRating !== "N/A") {
            return { type: 'IMDb', value: data.imdbRating };
        }

    } catch (e) {
        return null;
    }
    return null;
}

async function resolveToImdb(title, year) {
    if (!title) return null;
    
    // Strategy 1: Strict Search (Title + Year)
    try {
        if (year) {
            const query = `${title} ${year}`;
            const url = `${CINEMETA_URL}/search=${encodeURIComponent(query)}.json`;
            const { data } = await axios.get(url);
            if (data && data.metas && data.metas.length > 0) {
                return data.metas[0];
            }
        }
    } catch (e) {}

    // Strategy 2: Loose Search (Title Only) - Fixes issues where release year != metadata year
    try {
        const url = `${CINEMETA_URL}/search=${encodeURIComponent(title)}.json`;
        const { data } = await axios.get(url);
        if (data && data.metas && data.metas.length > 0) {
            // Verify it's somewhat recent to avoid matching a 1950s movie with same name
            const match = data.metas[0];
            if (match.releaseInfo && parseInt(match.releaseInfo) > 2000) {
                console.log(`> Loose match found for "${title}": ${match.name} (${match.releaseInfo})`);
                return match;
            }
        }
    } catch (e) {}

    return null;
}

async function scrapePages() {
    console.log('--- STARTING SCRAPE (v1.2.1) ---');
    lastStatus = "Scraping...";
    let allItems = [];
    let page = 1;

    try {
        // --- 1. HARVEST LINKS ---
        while (page <= TARGET_PAGE_COUNT) {
            if (allItems.length >= MAX_ITEMS) break;

            const url = page === 1 ? BASE_URL : `${BASE_URL}?pg=${page}`;
            console.log(`> Fetching Page ${page}...`);

            try {
                const response = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
                const $ = cheerio.load(response.data);
                let itemsFoundOnPage = 0;

                $('.jrResourceTitle, .jrListingTitle, h2 a, h3 a').each((i, el) => {
                    if (allItems.length >= MAX_ITEMS) return false;
                    const rawTitle = $(el).text().trim();
                    const href = $(el).attr('href');
                    
                    if (rawTitle && /\b(19|20)\d{2}\b/.test(rawTitle) && !rawTitle.includes("Guide")) {
                        if (!allItems.some(item => item.rawTitle === rawTitle)) {
                            allItems.push({ rawTitle, link: href });
                            itemsFoundOnPage++;
                        }
                    }
                });

                if (itemsFoundOnPage === 0 && page > 1) break;

            } catch (err) { break; }
            
            page++;
            await delay(800);
        }

        // --- 2. MATCH METADATA ---
        console.log(`> Processing ${allItems.length} items with Ratings...`);
        lastStatus = `Rating ${allItems.length} items...`;
        const newCatalog = [];

        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            
            // Resolve IMDb
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);

            if (imdbItem) {
                // Fetch Rating
                const ratingData = await getRating(imdbItem.id);
                
                let namePrefix = '';
                let descScore = 'Ratings: N/A (Too new?)';

                if (ratingData) {
                    if (ratingData.type === 'RT') {
                        namePrefix = `🍅 ${ratingData.value} `;
                        descScore = `Rotten Tomatoes: ${ratingData.value}`;
                    } else if (ratingData.type === 'Meta') {
                        namePrefix = `Ⓜ️ ${ratingData.value} `;
                        descScore = `Metacritic: ${ratingData.value}`;
                    } else if (ratingData.type === 'IMDb') {
                        namePrefix = `⭐ ${ratingData.value} `;
                        descScore = `IMDb: ${ratingData.value}`;
                    }
                }

                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: `${namePrefix}${imdbItem.name}`,
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `${descScore}\nrelease: ${item.rawTitle}`,
                    releaseInfo: imdbItem.releaseInfo
                });
            } else {
                // UNMATCHED ITEM
                newCatalog.push({
                    id: `wyw_${parsed.title.replace(/\s/g, '')}`,
                    type: 'movie',
                    name: parsed.title,
                    description: `Unmatched: ${item.rawTitle}`,
                    poster: null,
                    releaseInfo: parsed.year || '????'
                });
            }
            await delay(50); // Be nice to OMDB
        }

        // Deduplicate
        const seen = new Set();
        movieCatalog = newCatalog.filter(item => {
            const duplicate = seen.has(item.id);
            seen.add(item.id);
            return !duplicate;
        });

        lastStatus = "Ready";
        console.log(`> Update Complete. Size: ${movieCatalog.length}`);

    } catch (error) {
        console.error('! Error:', error.message);
        lastStatus = "Error: " + error.message;
    }
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (movieCatalog.length === 0) {
        return { metas: [{ id: 'tt_status', type: 'movie', name: `Status: ${lastStatus}`, description: "Fetching..." }] };
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
console.log(`Running on http://localhost:${PORT}`);
