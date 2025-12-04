const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const app = express();

const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const OMDB_API_KEY = 'a8924bd9'; // <--- MUST BE VALID FREE KEY
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// SETTINGS
const MAX_ITEMS = 300;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache
let movieCache = {
    timestamp: 0,
    data: []
};

// ID Mapping Cache (Title -> IMDB ID)
const idCache = new Map();

const builder = new addonBuilder({
    id: 'org.rottentomatoes.feed',
    version: '1.0.0',
    name: 'Rotten Tomatoes / Metacritic Feed',
    description: 'Scrapes latest reports and ratings.',
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'rt_latest',
            name: 'RT Latest Reports',
            extra: [{ name: 'search', isRequired: false }]
        }
    ]
});

// Helper: Clean title for better matching
function cleanTitle(title) {
    return title.replace(/\(\d{4}\)/, '').trim();
}

// Helper: Get IMDB ID from OMDB
async function getImdbId(title, year = null) {
    const cacheKey = `${title}-${year || ''}`;
    if (idCache.has(cacheKey)) return idCache.get(cacheKey);

    try {
        const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${OMDB_API_KEY}${year ? `&y=${year}` : ''}`;
        const response = await axios.get(url);
        
        if (response.data && response.data.imdbID) {
            idCache.set(cacheKey, response.data.imdbID);
            return response.data.imdbID;
        }
    } catch (error) {
        console.error(`OMDB Error for ${title}:`, error.message);
    }
    return null;
}

// Scraper Function
async function scrapeMovies() {
    const now = Date.now();
    if (movieCache.data.length > 0 && (now - movieCache.timestamp < CACHE_DURATION)) {
        console.log('Serving from cache');
        return movieCache.data;
    }

    console.log('Scraping fresh data...');
    try {
        const { data } = await axios.get(BASE_URL, {
            headers: { 'User-Agent': USER_AGENT }
        });
        
        const $ = cheerio.load(data);
        const movies = [];
        
        // Note: Selectors depend on the specific HTML structure of whereyouwatch.com
        // This is a generic robust selector strategy for blog-roll style sites
        const articles = $('article, .post, .entry'); 
        
        for (let i = 0; i < articles.length && movies.length < MAX_ITEMS; i++) {
            const el = articles[i];
            const titleRaw = $(el).find('h2, h3, .entry-title').first().text().trim();
            
            // Extract Year if present in title (e.g., "Movie Name (2024)")
            const yearMatch = titleRaw.match(/\((\d{4})\)/);
            const year = yearMatch ? yearMatch[1] : null;
            const title = cleanTitle(titleRaw);

            // Extract Rating/Score if available
            const score = $(el).find('.score, .rating, .grade').text().trim() || '';
            const description = $(el).find('p, .excerpt').first().text().trim();
            const poster = $(el).find('img').attr('src');

            if (title) {
                // Get IMDB ID
                const imdbId = await getImdbId(title, year);
                
                if (imdbId) {
                    movies.push({
                        id: imdbId,
                        type: 'movie',
                        name: title,
                        poster: poster,
                        description: `RT/Meta Score: ${score}\n\n${description}`,
                        releaseInfo: year || 'N/A'
                    });
                }
            }
        }

        movieCache = {
            timestamp: now,
            data: movies
        };
        
        return movies;

    } catch (error) {
        console.error('Scraping failed:', error.message);
        return movieCache.data; // Return stale data if scrape fails
    }
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type === 'movie' && id === 'rt_latest') {
        const movies = await scrapeMovies();
        return { metas: movies };
    }
    return { metas: [] };
});

// Start Server
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Addon active on port ${PORT}`);
console.log(`Open http://localhost:${PORT}/manifest.json in Stremio`);
