import { Actor } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import sanitizeHtml from 'sanitize-html';
import crypto from 'crypto';

await Actor.init();

// Getting user input
const input = await Actor.getInput();

const platforms = (input && input.platforms) || ['hackernews', 'reddit', 'github', 'devto', 'medium', 'news'];
const keywords = (input && input.keywords) || ['artificial intelligence', 'machine learning', 'data science'];
const maxRecords = (input && input.maxRecords) || 1000;
const includeImages = (input && input.includeImages !== undefined) ? input.includeImages : true;
const minTextLength = (input && input.minTextLength) || 50;



// Build starting URLs
const startUrls = [];


for (const platform of platforms) {
    for (const keyword of keywords) {
        if (platform === 'reddit') {
            startUrls.push({
                url: `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=top&limit=100`,
                userData: { platform: 'reddit', keyword },
            });
        } else if (platform === 'x') {
            startUrls.push({
                url: `https://twitter.com/search?q=${encodeURIComponent(keyword)}&src=typed_query`,
                userData: { platform: 'twitter', keyword },
            });
        } else if (platform === 'news') {
            startUrls.push({
                url: `https://news.google.com/search?q=${encodeURIComponent(keyword)}&hl=en-US&gl=US&ceid=US:en`,
                userData: { platform: 'news', keyword },
            });
        } else if (platform === 'hackernews') {
            startUrls.push({
                url: `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=story&hitsPerPage=50`,
                userData: { platform: 'hackernews', keyword },
            });
        } else if (platform === 'github') {
            startUrls.push({
                url: `https://api.github.com/search/repositories?q=${encodeURIComponent(keyword)}&sort=stars&per_page=100`,
                userData: { platform: 'github', keyword },
            });
        } else if (platform === 'devto') {
            startUrls.push({
                url: `https://dev.to/search?q=${encodeURIComponent(keyword)}`,
                userData: { platform: 'devto', keyword },
            });
        } else if (platform === 'medium') {
            startUrls.push({
                url: `https://medium.com/search?q=${encodeURIComponent(keyword)}`,
                userData: { platform: 'medium', keyword },
            });
        }
        console.log(`  ✅ Added URL for ${platform}`);
    }
}

let recordCount = 0;
startUrls.forEach(url => console.log(`  ✓ ${url.userData.platform}: ${url.url.substring(0, 80)}...`));
const seenHashes = new Set();

const crawler = new PuppeteerCrawler({
     proxyConfiguration: await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'], 
    }),
    async requestHandler({ request, page, log }) {
        await page.setExtraHTTPHeaders({
            'Accept': 'application/json, text/html',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        if (recordCount >= maxRecords) {
            log.info('Max records reached, stopping...');
            return;
        }

        const { platform, keyword } = request.userData;
        log.info(`Scraping ${platform} for "${keyword}"`);

        let results = [];

        try {
            if (platform === 'reddit') {
                results = await scrapeReddit(page, includeImages);
            } else if (platform === 'twitter') {
                results = await scrapeTwitter(page, includeImages);
            } else if (platform === 'news') {
                results = await scrapeNews(page);
            } else if (platform === 'hackernews') {
                results = await scrapeHackerNews(page);
            } else if (platform === 'github') {
                results = await scrapeGitHub(page);
            } else if (platform === 'devto') {
                results = await scrapeDevTo(page);
            } else if (platform === 'medium') {
                results = await scrapeMedium(page);
            } else {
                log.warning(`Unsupported platform: ${platform}`);
                return;
            }

            log.info(`Scraped ${results.length} items from ${platform}`);   

            // Filter and deduplicate
            results = results
                .filter(item => item.text?.content && item.text.content.length >= minTextLength)
                .filter(item => {
                    const hash = hashContent(item.text.content);
                    if (seenHashes.has(hash)) return false;
                    seenHashes.add(hash);
                    return true;
                });

            // Save to dataset
            for (const item of results) {
                if (recordCount >= maxRecords) break;
                
                await Actor.pushData({
                    ...item,
                    keyword,
                    scraped_at: new Date().toISOString(),
                });
                
                recordCount++;
            }

            log.info(`Collected ${results.length} records. Total: ${recordCount}/${maxRecords}`);

        } catch (error) {
            log.error(`Error scraping ${platform}:`, error);
        }
    },
    maxRequestsPerCrawl: startUrls.length * 5,
    maxConcurrency: 1, // Changed to 1 for reliability
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled' // Hide automation
            ],
        },
    },
});

await crawler.run(startUrls);

console.log(`\n✅ Scraping completed! Total records collected: ${recordCount}`);

await Actor.exit();

// ==================== SCRAPING FUNCTIONS ====================



async function scrapeReddit(page, includeImages) {
    console.log('📥 Fetching Reddit JSON data...');
    
    // Get the JSON content from the page
    const content = await page.content();
    
    // The browser shows JSON in a <pre> tag, so let's extract it
    const jsonData = await page.evaluate(() => {
        const preTag = document.querySelector('pre');
        if (preTag) {
            return preTag.textContent;
        }
        return document.body.textContent;
    });
    
    console.log(`📄 Received ${jsonData.length} characters of JSON`);
    
    try {
        const data = JSON.parse(jsonData);
        const results = [];
        
        // Reddit's JSON structure: data.data.children contains the posts
        if (data.data && data.data.children) {
            const posts = data.data.children;
            console.log(`✅ Found ${posts.length} posts in JSON`);
            
            posts.forEach((item, index) => {
                const post = item.data;
                
                // Skip if no title
                if (!post.title) return;
                
                // Build full text
                const fullText = post.selftext ? 
                    `${post.title}\n\n${post.selftext}` : 
                    post.title;
                
                // Get images
                const images = [];
                if (includeImages) {
                    if (post.preview && post.preview.images) {
                        post.preview.images.forEach(img => {
                            if (img.source && img.source.url) {
                                // Decode HTML entities in URL
                                const imageUrl = img.source.url.replace(/&amp;/g, '&');
                                images.push(imageUrl);
                            }
                        });
                    }
                    // Also check for direct image URLs
                    if (post.url && (post.url.includes('.jpg') || post.url.includes('.png'))) {
                        images.push(post.url);
                    }
                }
                
                results.push({
                    record_id: `reddit_${post.id}`,
                    source: 'reddit',
                    url: `https://reddit.com${post.permalink}`,
                    content_type: images.length > 0 ? 'text_image' : 'text',
                    text: {
                        title: post.title,
                        content: fullText,
                    },
                    media: {
                        images: images.slice(0, 5),
                    },
                    metadata: {
                        subreddit: post.subreddit_name_prefixed || `r/${post.subreddit}`,
                        score: post.score,
                        author: post.author,
                        comments: post.num_comments,
                        created: new Date(post.created_utc * 1000).toISOString(),
                        has_images: images.length > 0,
                    },
                });
            });
        }
        
        return results;
        
    } catch (error) {
        console.error('❌ Error parsing Reddit JSON:', error.message);
        console.log('First 500 chars:', jsonData.substring(0, 500));
        return [];
    }
}

async function scrapeHackerNews(page) {
    const jsonData = await page.evaluate(() => {
        const preTag = document.querySelector('pre');
        if (preTag) return preTag.textContent;
        return document.body.textContent;
    });
    
    try {
        const data = JSON.parse(jsonData);
        const results = [];
        
        if (data.hits && Array.isArray(data.hits)) {
            console.log(`✅ Found ${data.hits.length} HackerNews stories`);
            
            data.hits.forEach((hit) => {
                if (!hit.title) return;
                
                const text = hit.story_text || hit.title;
                
                results.push({
                     record_id: `hn_${hit.objectID}`,
                    source: 'hackernews',
                    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
                    content_type: 'text',
                    text: {
                        title: hit.title,
                        content: text,
                    },
                    media: {
                        images: [],
                    },
                    metadata: {
                        author: hit.author,
                        points: hit.points || 0,
                        comments: hit.num_comments || 0,
                        created: hit.created_at,
                    },
                });
            });
        }
        
        return results;
        
    } catch (error) {
        console.error('❌ Error parsing HackerNews JSON:', error.message);
        return [];
    }
}

async function scrapeGitHub(page) {
    console.log('📥 Fetching GitHub API data...');
    
    const jsonData = await page.evaluate(() => {
        const preTag = document.querySelector('pre');
        if (preTag) return preTag.textContent;
        return document.body.textContent;
    });
    
    try {
        const data = JSON.parse(jsonData);
        const results = [];
        
        if (data.items && Array.isArray(data.items)) {
            console.log(`✅ Found ${data.items.length} GitHub repositories`);
            
            data.items.forEach((repo) => {
                const fullText = `${repo.name}\n\n${repo.description || ''}${repo.topics ? '\n\nTopics: ' + repo.topics.join(', ') : ''}`;
                
                results.push({
                    record_id: `github_${repo.id}`,
                    source: 'github',
                    url: repo.html_url,
                    content_type: 'text',
                    text: {
                        title: repo.full_name,
                        content: fullText,
                    },
                    media: {
                        images: [],
                    },
                    metadata: {
                        language: repo.language,
                        stars: repo.stargazers_count,
                        forks: repo.forks_count,
                        open_issues: repo.open_issues_count,
                        created: repo.created_at,
                        updated: repo.updated_at,
                        author: repo.owner.login,
                    },
                });
            });
        }
        
        return results;
        
    } catch (error) {
        console.error('❌ Error parsing GitHub JSON:', error.message);
        return [];
    }
}

async function scrapeDevTo(page) {
    console.log('📥 Fetching Dev.to data...');
    
    try {
        await page.waitForSelector('article, .crayons-story', { timeout: 10000 });
        
        const results = await page.evaluate(() => {
            const results = [];
            const articles = document.querySelectorAll('article.crayons-story, .crayons-story');
            
            articles.forEach((article, index) => {
                if (index >= 30) return;
                
                try {
                    const titleEl = article.querySelector('h2 a, h3 a, .crayons-story__title a');
                    const snippetEl = article.querySelector('.crayons-story__snippet, p');
                    const authorEl = article.querySelector('.crayons-story__secondary a, [data-user-id]');
                    const tagsEls = article.querySelectorAll('.crayons-tag, .tag');
                    
                    const title = titleEl?.textContent?.trim() || '';
                    const snippet = snippetEl?.textContent?.trim() || '';
                    const text = `${title}\n\n${snippet}`.trim();
                    const url = titleEl?.href || '';
                    
                    if (!text || !url) return;
                    
                    const tags = Array.from(tagsEls).map(t => t.textContent.trim()).filter(Boolean);
                    
                    results.push({
                        record_id: `devto_${Date.now()}_${index}`,
                        source: 'devto',
                        url: url.startsWith('http') ? url : `https://dev.to${url}`,
                        content_type: 'text',
                        text: {
                            title: title,
                            content: text,
                        },
                        media: {
                            images: [],
                        },
                        metadata: {
                            author: authorEl?.textContent?.trim() || '',
                            tags: tags,
                        },
                    });
                } catch (err) {
                    console.error('Error parsing Dev.to article:', err);
                }
            });
            
            return results;
        });
        
        console.log(`✅ Found ${results.length} Dev.to articles`);
        return results;
        
    } catch (error) {
        console.error('❌ Error scraping Dev.to:', error.message);
        return [];
    }
}

async function scrapeMedium(page) {
    console.log('📥 Fetching Medium data...');
    
    try {
        await page.waitForSelector('article, div[data-testid="story"]', { timeout: 10000 });
        
        const results = await page.evaluate(() => {
            const results = [];
            const articles = document.querySelectorAll('article, div[data-testid="story"]');
            
            articles.forEach((article, index) => {
                if (index >= 30) return;
                
                try {
                    const titleEl = article.querySelector('h2, h3, [data-testid="story-title"]');
                    const snippetEl = article.querySelector('h3 + p, p, [data-testid="story-subtitle"]');
                    const authorEl = article.querySelector('a[rel="author"], [data-testid="story-author"]');
                    const linkEl = article.querySelector('a[href*="/"]');
                    
                    const title = titleEl?.textContent?.trim() || '';
                    const snippet = snippetEl?.textContent?.trim() || '';
                    const text = `${title}\n\n${snippet}`.trim();
                    const url = linkEl?.href || '';
                    
                    if (!text || text.length < 20) return;
                    
                    results.push({
                        record_id: `medium_${Date.now()}_${index}`,
                        source: 'medium',
                        url: url,
                        content_type: 'text',
                        text: {
                            title: title,
                            content: text,
                        },
                        media: {
                            images: [],
                        },
                        metadata: {
                            author: authorEl?.textContent?.trim() || '',
                        },
                    });
                } catch (err) {
                    console.error('Error parsing Medium article:', err);
                }
            });
            
            return results;
        });
        
        console.log(`✅ Found ${results.length} Medium articles`);
        return results;
        
    } catch (error) {
        console.error('❌ Error scraping Medium:', error.message);
        return [];
    }
}

async function scrapeTwitter(page, includeImages) {
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 });
    
    return await page.evaluate((includeImages) => {
        const results = [];
        const tweets = document.querySelectorAll('article[data-testid="tweet"]');
        
        tweets.forEach((tweet, index) => {
            if (index >= 20) return;
            
            try {
                const textEl = tweet.querySelector('[data-testid="tweetText"]');
                const authorEl = tweet.querySelector('[data-testid="User-Name"]');
                const timeEl = tweet.querySelector('time');
                
                const text = textEl?.textContent?.trim() || '';
                if (!text) return;
                
                const images = includeImages ?
                    Array.from(tweet.querySelectorAll('img[src*="pbs.twimg.com/media"]'))
                        .map(img => img.src)
                        .slice(0, 4) : [];
                
                results.push({
                     record_id: `twitter_${Date.now()}_${index}`,
                    source: 'twitter',
                    url: window.location.href,
                    content_type: images.length > 0 ? 'text_image' : 'text',
                    text: {
                        content: text,
                    },
                    media: {
                        images: images,
                    },
                    metadata: {
                        author: authorEl?.textContent?.trim() || '',
                        timestamp: timeEl?.getAttribute('datetime') || '',
                        has_images: images.length > 0,
                    },
                });
            } catch (err) {
                console.error('Error parsing tweet:', err);
            }
        });
        
        return results;
    }, includeImages);
}

async function scrapeNews(page) {
    console.log('📥 Fetching Google News data...');
    
    try {
        await page.waitForSelector('article, c-wiz, a[href*="/articles/"]', { timeout: 10000 });
        
        const results = await page.evaluate(() => {
            const results = [];
            const articles = document.querySelectorAll('article, c-wiz[jsrenderer]');
            
            articles.forEach((article, index) => {
                if (index >= 20) return;
                
                try {
                    const titleEl = article.querySelector('h3, h4, a[aria-label]');
                    const snippetEl = article.querySelector('p, span');
                    const linkEl = article.querySelector('a[href]');
                    const sourceEl = article.querySelector('[data-n-tid]');
                    
                    const title = titleEl?.textContent?.trim() || '';
                    const snippet = snippetEl?.textContent?.trim() || '';
                    const text = snippet ? `${title}\n\n${snippet}`.trim() : title;
                    
                    if (!text || text.length < 20) return;
                    
                    const url = linkEl?.href || window.location.href;
                    
                    results.push({
                        record_id: `news_${Date.now()}_${index}`,
                        source: 'news',
                        url: url,
                        content_type: 'text',
                        text: {
                            title: title,
                            content: text,
                        },
                        media: {
                            images: [],
                        },
                        metadata: {
                            source_site: sourceEl?.textContent?.trim() || new URL(url).hostname,
                        },
                    });
                } catch (err) {
                    console.error('Error parsing news article:', err);
                }
            });
            
            return results;
        });
        
        console.log(`✅ Found ${results.length} news articles`);
        return results;
        
    } catch (error) {
        console.error('❌ Error scraping Google News:', error.message);
        return [];
    }
}

// ==================== UTILITY FUNCTIONS ====================

function hashContent(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}