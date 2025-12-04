const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const OMDB_API_KEY = 'a8924bd9'; 
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const CACHE_FILE = path.join(__dirname, 'omdb_ratings_cache.json');

// SETTINGS
const MAX_ITEMS = 300; 
const TARGET_PAGE_COUNT = 30; 

const manifest = {
    id: 'org.whereyouwatch.reports.rt',
    version: '1.2.7', 
    name: 'WhereYouWatch + Ratings',
    description: 'Latest releases with cached RT/IMDb/Metacritic',
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
let ratingsCache = {};

// --- CACHE SYSTEM ---
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE, 'utf8');
            ratingsCache = JSON.parse(data);
            console.log(`> Cache loaded: ${Object.keys(ratingsCache).length} ratings`);
        }
    } catch (e) {
        console.error('! Failed to load cache:', e.message);
        ratingsCache = {};
    }
}

function saveCache() {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(ratingsCache, null, 2));
    } catch (e) {
        console.error('! Failed to save cache:', e.message);
    }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseReleaseTitle(rawString) {
    const yearMatch = rawString.match(/(19|20)\d{2}/);
    if (yearMatch) {
        const yearIndex = yearMatch.index;
        let title = rawString.substring(0, yearIndex).trim();
        // Clean dots/underscores and ensure single spaces
        title = title.replace(/[\._]/g, ' ').replace(/\s+/g, ' ').trim();
        title = title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
        return { title: title, year: yearMatch[0] };
    }
    let cleanTitle = rawString.replace(/[\._]/g, ' ').trim();
    return { title: cleanTitle, year: null };
}

// --- NEW: ROBUST ROTTEN TOMATOES FETCH ---
async function fetchRottenTomatoesDirect(title, year) {
    try {
        // Strategy: Try searching just the Title first. 
        // If that fails (e.g. "Troll 2" returns the 1990 movie), try "Title Year" ("Troll 2 2025")
        let searchQueries = [title];
        if (year) searchQueries.push(`${title} ${year}`);

        for (const query of searchQueries) {
            // console.log(`> 🍅 RT Search: "${query}"...`);
            const url = `https://www.rottentomatoes.com/napi/search/all?query=${encodeURIComponent(query)}&limit=10`;
            const { data } = await axios.get(url, { 
                headers: { 'User-Agent': USER_AGENT } 
            });

            if (data && data.movie && data.movie.items && data.movie.items.length > 0) {
                const match = data.movie.items.find(m => {
                    if (year && m.releaseYear) {
                        const diff = Math.abs(parseInt(m.releaseYear) - parseInt(year));
                        return diff <= 1; // Allow 2024/2025 variance
                    }
                    return true;
                });

                if (match && match.tomatometerScore && match.tomatometerScore.score) {
                    return {
                        type: 'RT',
                        value: `${match.tomatometerScore.score}%`,
                        source: 'Direct'
                    };
                }
            }
            await delay(200); // Be polite between retries
        }
    } catch (e) {
        // console.error(`! RT Direct Error: ${e.message}`);
    }
    return null;
}

// Helper: Try to resolve movie via OMDB directly if Cinemeta fails
async function resolveViaOmdb(title, year) {
    if (!OMDB_API_KEY || OMDB_API_KEY.includes('YOUR_OMDB')) return null;
    const cleanTitle = title.replace(/\./g, ' ').trim();

    try {
        // 1. Strict Search
        let queryUrl = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&t=${encodeURIComponent(cleanTitle)}&plot=full`;
        if (year) queryUrl += `&y=${year}`;

        let { data } = await axios.get(queryUrl);

        // 2. Loose Search (No Year)
        if (year && (!data || data.Response === 'False')) {
            const looseUrl = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&t=${encodeURIComponent(cleanTitle)}&plot=full`;
            const looseRes = await axios.get(looseUrl);
            if (looseRes.data && looseRes.data.Response === 'True') data = looseRes.data;
        }

        // 3. Search Fallback (s=Title)
        if (!data || data.Response === 'False') {
             const searchUrl = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&s=${encodeURIComponent(cleanTitle)}`;
             const searchRes = await axios.get(searchUrl);
             
             if (searchRes.data && searchRes.data.Search && searchRes.data.Search.length > 0) {
                 const firstId = searchRes.data.Search[0].imdbID;
                 const detailUrl = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${firstId}&plot=full`;
                 const detailRes = await axios.get(detailUrl);
                 if (detailRes.data && detailRes.data.Response === 'True') data = detailRes.data;
             }
        }

        if (data && data.Response === 'True' && data.imdbID) {
            // Cache ratings if found
            let result = null;
            if (data.Ratings) {
                const rt = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
                if (rt) result = { type: 'RT', value: rt.Value };
            }
            if (!result && data.Metascore && data.Metascore !== "N/A") result = { type: 'Meta', value: data.Metascore };
            if (!result && data.imdbRating && data.imdbRating !== "N/A") result = { type: 'IMDb', value: data.imdbRating };

            if (result) ratingsCache[data.imdbID] = result;

            return {
                id: data.imdbID,
                name: data.Title,
                releaseInfo: data.Year,
                poster: (data.Poster && data.Poster !== "N/A") ? data.Poster : null,
                plot: (data.Plot && data.Plot !== "N/A") ? data.Plot : null
            };
        }
    } catch(e) {}
    return null;
}

// Helper to fetch Scores from OMDB (RT -> Metacritic -> IMDb)
async function getRating(imdbId) {
    if (ratingsCache[imdbId]) return ratingsCache[imdbId];
    if (!OMDB_API_KEY || OMDB_API_KEY.includes('YOUR_OMDB')) return null;

    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbId}`;
        const { data } = await axios.get(url);
        
        if (!data || data.Response === 'False') return null;

        let result = null;
        if (data.Ratings) {
            const rt = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
            if (rt) result = { type: 'RT', value: rt.Value };
        }
        if (!result && data.Metascore && data.Metascore !== "N/A") result = { type: 'Meta', value: data.Metascore };
        if (!result && data.imdbRating && data.imdbRating !== "N/A") result = { type: 'IMDb', value: data.imdbRating };

        if (result) ratingsCache[imdbId] = result;
        return result;

    } catch (e) { return null; }
}

async function resolveToImdb(title, year) {
    if (!title) return null;
    try {
        if (year) {
            const query = `${title} ${year}`;
            const url = `${CINEMETA_URL}/search=${encodeURIComponent(query)}.json`;
            const { data } = await axios.get(url);
            if (data && data.metas && data.metas.length > 0) return data.metas[0];
        }
    } catch (e) {}
    try {
        const url = `${CINEMETA_URL}/search=${encodeURIComponent(title)}.json`;
        const { data } = await axios.get(url);
        if (data && data.metas && data.metas.length > 0) {
            const match = data.metas[0];
            if (match.releaseInfo && parseInt(match.releaseInfo) > 2000) return match;
        }
    } catch (e) {}
    return null;
}

async function scrapePages() {
    console.log('--- STARTING SCRAPE (v1.2.7) ---');
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
        let newRatingsFound = false;
        const initialCacheSize = Object.keys(ratingsCache).length;

        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            
            let imdbItem = await resolveToImdb(parsed.title, parsed.year);

            if (!imdbItem) {
                imdbItem = await resolveViaOmdb(parsed.title, parsed.year);
            }

            if (imdbItem) {
                // 1. Get OMDB Rating
                let ratingData = await getRating(imdbItem.id);
                
                // 2. If OMDB has no RT score, try Direct RT Fetch
                if (!ratingData || ratingData.type !== 'RT') {
                    const rtDirect = await fetchRottenTomatoesDirect(parsed.title, parsed.year);
                    if (rtDirect) {
                        ratingData = rtDirect;
                        ratingsCache[imdbItem.id] = rtDirect; 
                    }
                }

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

                const plotText = imdbItem.plot ? `\n\n${imdbItem.plot}` : '';
                const posterUrl = imdbItem.poster || `https://images.metahub.space/poster/medium/${imdbItem.id}/img`;

                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: `${namePrefix}${imdbItem.name}`,
                    poster: posterUrl,
                    description: `${descScore}\nrelease: ${item.rawTitle}${plotText}`,
                    releaseInfo: imdbItem.releaseInfo,
                    behaviorHints: { defaultVideoId: imdbItem.id }
                });
            } else {
                newCatalog.push({
                    id: `wyw_${parsed.title.replace(/[^a-zA-Z0-9]/g, '')}`,
                    type: 'movie',
                    name: parsed.title,
                    description: `Unmatched: ${item.rawTitle}`,
                    poster: null,
                    releaseInfo: parsed.year || '????'
                });
            }
            await delay(50); 
        }

        if (Object.keys(ratingsCache).length > initialCacheSize) {
            newRatingsFound = true;
            saveCache();
        }

        const seen = new Set();
        movieCatalog = newCatalog.filter(item => {
            const duplicate = seen.has(item.id);
            seen.add(item.id);
            return !duplicate;
        });

        lastStatus = "Ready";
        console.log(`> Update Complete. Size: ${movieCatalog.length} (New Ratings Cached: ${newRatingsFound})`);

    } catch (error) {
        console.error('! Error:', error.message);
        lastStatus = "Error: " + error.message;
    }
}

loadCache();

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
