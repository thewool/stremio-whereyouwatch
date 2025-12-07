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
    version: '1.2.8', 
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

// --- 1. OMDB Fetcher (Primary & Reliable) ---
async function fetchScoresFromOmdb(imdbId) {
    // Check Cache First
    if (ratingsCache[imdbId]) return ratingsCache[imdbId];
    if (!imdbId) return null;

    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${imdbId}`;
        const { data } = await axios.get(url);

        if (data && data.Response === 'True') {
            let result = null;

            // Prioritize Rotten Tomatoes
            if (data.Ratings) {
                const rt = data.Ratings.find(r => r.Source === "Rotten Tomatoes");
                if (rt) result = { type: 'RT', value: rt.Value };
            }

            // Fallbacks
            if (!result && data.Metascore && data.Metascore !== "N/A") result = { type: 'Meta', value: data.Metascore };
            if (!result && data.imdbRating && data.imdbRating !== "N/A") result = { type: 'IMDb', value: data.imdbRating };

            if (result) {
                console.log(`> 🍅 OMDB Hit for ${imdbId}: ${result.value}`);
                ratingsCache[imdbId] = result; // Save to cache
                return result;
            }
        }
    } catch (e) {
        // console.log(`! OMDB Error: ${e.message}`);
    }
    return null;
}

// --- 2. RT Direct Fetcher (Fallback - HTML Scraping) ---
async function fetchRottenTomatoesFallback(title, year) {
    try {
        const query = year ? `${title} ${year}` : title;
        // Search page often returns a list of movies
        const url = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, { 
            headers: { 'User-Agent': USER_AGENT } 
        });

        // Loose regex to find the score in the search results HTML
        // Looks for "tomatometerscore="88"" or similar attributes
        const scoreMatch = data.match(/tomatometerscore="(\d+)"/i);
        if (scoreMatch && scoreMatch[1]) {
            console.log(`> 🍅 Scrape Hit for "${title}": ${scoreMatch[1]}%`);
            return { type: 'RT', value: `${scoreMatch[1]}%`, source: 'Scrape' };
        }
    } catch (e) {
        console.log(`! RT Scrape Error for "${title}": ${e.message}`);
    }
    return null;
}

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
    console.log('--- STARTING SCRAPE (v1.2.8) ---');
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
                // 1. Get Score (OMDB First, then Fallback)
                let ratingData = await fetchScoresFromOmdb(imdbItem.id);
                
                // 2. If OMDB failed to get RT score, try Direct HTML Fallback
                if (!ratingData || ratingData.type !== 'RT') {
                    const rtDirect = await fetchRottenTomatoesFallback(parsed.title, parsed.year);
                    if (rtDirect) {
                        ratingData = rtDirect;
                        // Cache explicitly since we bypassed standard OMDB
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
