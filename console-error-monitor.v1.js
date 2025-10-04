const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');

puppeteer.use(StealthPlugin());

class ConsoleErrorMonitor {
  constructor(config = {}) {
    this.config = {
      baseUrls: config.baseUrls || ['https://www.salesforce.com'],
      confPatterns: config.confPatterns || ['/conf/', '/confirmation/', '/asyncconf'],
      locales: config.locales || ['en-US'],
      maxConcurrent: config.maxConcurrent || 10,
      timeout: config.timeout || 30000,
      outputDir: config.outputDir || './reports',
      retryLimit: config.retryLimit || 2
    };
    
    this.errors = new Map();
    this.urlErrors = new Map();
    this.processedUrls = new Set();
  }

  // Generate all possible confirmation page URLs
  generateUrls() {
    const urls = [];
    
    // Example URL patterns - customize based on your needs
    const paths = [
      '/form/signup/conf/asyncconf',
      '/form/signup/conf/freetrial-conf-lb',
      '/form/signup/',
      /* '/form/signup/conf/dropbox-beta-program',
      '/form/signup/conf/emergency-response',
      '/form/signup/conf/freetrial-elf-v2',
      '/form/signup/conf/freetrial-elf-v2-hp',
      '/form/signup/conf/freetrial-service-elf-v2',*/
    ];
    
    for (const baseUrl of this.config.baseUrls) {
      for (const path of paths) {
        /*for (const locale of this.config.locales) {
          // Generate locale-specific URLs
          urls.push(`${baseUrl}/${locale}${path}`);
          urls.push(`${baseUrl}${path}?locale=${locale}`);
        }COMMENTED AS LOCALE LOGIC NOT FINAL*/
        // Also add non-locale version
        urls.push(`${baseUrl}${path}`);
      }
    }
    
    return urls;
  }

  // Process a single URL and collect console errors
  async processUrl(browser, url) {
    let page;
    let retries = 0;
    
    while (retries <= this.config.retryLimit) {
      try {
        page = await browser.newPage();
        const errors = [];
        
        // Set up console error listener
        page.on('console', msg => {
          if (msg.type() === 'error') {
            errors.push({
              text: msg.text(),
              location: msg.location(),
              args: msg.args().map(arg => arg.toString())
            });
          }
        });
        
        // Listen for page errors
        page.on('pageerror', error => {
          errors.push({
            text: error.message,
            stack: error.stack,
            type: 'pageerror'
          });
        });
        
        // Navigate to the page
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: this.config.timeout
        });
        
        // Wait a bit for any delayed errors
        //await page.waitForTimeout(2000);
        
        // Store errors if any found
        if (errors.length > 0) {
          this.storeErrors(url, errors);
        }
        
        await page.close();
        return { url, success: true, errorCount: errors.length };
        
      } catch (error) {
        retries++;
        if (page) await page.close().catch(() => {});
        
        if (retries > this.config.retryLimit) {
          console.error(`Failed to process ${url}: ${error.message}`);
          return { url, success: false, error: error.message };
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
    }
  }

  // Store and group errors
  storeErrors(url, errors) {
    // Store URL-specific errors
    this.urlErrors.set(url, errors);
    
    // Group similar errors
    for (const error of errors) {
      const errorKey = this.normalizeError(error.text);
      
      if (!this.errors.has(errorKey)) {
        this.errors.set(errorKey, {
          message: error.text,
          urls: new Set(),
          count: 0,
          firstSeen: new Date(),
          details: error
        });
      }
      
      const errorGroup = this.errors.get(errorKey);
      errorGroup.urls.add(url);
      errorGroup.count++;
      errorGroup.lastSeen = new Date();
    }
  }

  // Normalize error messages for grouping
  normalizeError(errorText) {
    return errorText
      .replace(/https?:\/\/[^\s]+/g, '[URL]')
      .replace(/\d+/g, '[NUMBER]')
      .replace(/\s+/g, ' ')
      .replace(/at line \d+:\d+/g, 'at line [LINE]')
      .trim()
      .substring(0, 200);
  }

  // Process URLs in batches
  async processUrls(urls) {
    const browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });

    const results = [];
    const batches = [];
    
    // Create batches
    for (let i = 0; i < urls.length; i += this.config.maxConcurrent) {
      batches.push(urls.slice(i, i + this.config.maxConcurrent));
    }
    
    // Process batches
    for (let i = 0; i < batches.length; i++) {
      console.log(`Processing batch ${i + 1}/${batches.length}`);
      
      const batchPromises = batches[i].map(url => 
        this.processUrl(browser, url)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      results.push(...batchResults.map(r => r.value || r.reason));
      
      // Small delay between batches
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    await browser.close();
    return results;
  }

  // Generate HTML report
  async generateHtmlReport() {
    const timestamp = new Date().toISOString();
    const sortedErrors = Array.from(this.errors.entries())
      .sort((a, b) => b[1].count - a[1].count);
    
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Console Error Report - ${timestamp}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
    }
    h1 { font-size: 2em; margin-bottom: 10px; }
    .meta {
      display: flex;
      gap: 30px;
      margin-top: 15px;
      opacity: 0.9;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      padding: 30px;
      background: #fafafa;
      border-bottom: 1px solid #e0e0e0;
    }
    .stat {
      text-align: center;
      padding: 20px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.05);
    }
    .stat-number {
      font-size: 2.5em;
      font-weight: bold;
      color: #667eea;
    }
    .stat-label {
      color: #666;
      margin-top: 5px;
    }
    .errors { padding: 30px; }
    .error-group {
      margin-bottom: 30px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      overflow: hidden;
    }
    .error-header {
      background: #f8f8f8;
      padding: 15px 20px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.3s;
    }
    .error-header:hover { background: #f0f0f0; }
    .error-title {
      flex: 1;
      font-family: 'Courier New', monospace;
      font-size: 0.95em;
      color: #d73027;
      word-break: break-word;
    }
    .error-stats {
      display: flex;
      gap: 20px;
      align-items: center;
    }
    .badge {
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 0.85em;
      font-weight: bold;
    }
    .badge.count {
      background: #fee0e0;
      color: #d73027;
    }
    .badge.urls {
      background: #e0f0ff;
      color: #2166ac;
    }
    .error-details {
      padding: 20px;
      background: #fafafa;
      display: none;
    }
    .error-details.active { display: block; }
    .url-list {
      margin-top: 15px;
      max-height: 300px;
      overflow-y: auto;
    }
    .url-item {
      padding: 8px 12px;
      background: white;
      margin-bottom: 5px;
      border-radius: 4px;
      border-left: 3px solid #667eea;
      font-size: 0.9em;
    }
    .url-item a {
      color: #2166ac;
      text-decoration: none;
      word-break: break-all;
    }
    .url-item a:hover { text-decoration: underline; }
    .filter-bar {
      padding: 20px 30px;
      background: #fafafa;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      gap: 15px;
      align-items: center;
    }
    input[type="search"] {
      flex: 1;
      padding: 10px 15px;
      border: 1px solid #ddd;
      border-radius: 5px;
      font-size: 1em;
    }
    select {
      padding: 10px 15px;
      border: 1px solid #ddd;
      border-radius: 5px;
      font-size: 1em;
      background: white;
    }
    .no-errors {
      text-align: center;
      padding: 60px 30px;
      color: #666;
    }
    .no-errors svg {
      width: 80px;
      height: 80px;
      margin-bottom: 20px;
      color: #4ade80;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔍 Console Error Monitor Report</h1>
      <div class="meta">
        <div>📅 Generated: ${new Date(timestamp).toLocaleString()}</div>
        <div>🌐 Total URLs Scanned: ${this.processedUrls.size}</div>
        <div>⏱️ Next Run: ${new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleString()}</div>
      </div>
    </header>
    
    <div class="summary">
      <div class="stat">
        <div class="stat-number">${this.errors.size}</div>
        <div class="stat-label">Unique Errors</div>
      </div>
      <div class="stat">
        <div class="stat-number">${Array.from(this.errors.values()).reduce((sum, e) => sum + e.count, 0)}</div>
        <div class="stat-label">Total Occurrences</div>
      </div>
      <div class="stat">
        <div class="stat-number">${this.urlErrors.size}</div>
        <div class="stat-label">Affected Pages</div>
      </div>
      <div class="stat">
        <div class="stat-number">${((this.urlErrors.size / this.processedUrls.size) * 100).toFixed(1)}%</div>
        <div class="stat-label">Error Rate</div>
      </div>
    </div>
    
    <div class="filter-bar">
      <input type="search" id="searchInput" placeholder="Search errors...">
      <select id="sortSelect">
        <option value="count">Sort by Count</option>
        <option value="urls">Sort by URLs Affected</option>
        <option value="recent">Sort by Most Recent</option>
      </select>
    </div>
    
    <div class="errors">
      ${sortedErrors.length === 0 ? `
        <div class="no-errors">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <h2>No Errors Found!</h2>
          <p>All confirmation pages are running without console errors.</p>
        </div>
      ` : sortedErrors.map(([key, error], index) => `
        <div class="error-group" data-error="${key}">
          <div class="error-header" onclick="toggleDetails(${index})">
            <div class="error-title">${this.escapeHtml(error.message)}</div>
            <div class="error-stats">
              <span class="badge count">${error.count} occurrences</span>
              <span class="badge urls">${error.urls.size} pages</span>
            </div>
          </div>
          <div class="error-details" id="details-${index}">
            <strong>First seen:</strong> ${error.firstSeen.toLocaleString()}<br>
            <strong>Last seen:</strong> ${error.lastSeen.toLocaleString()}<br>
            
            <div class="url-list">
              <strong>Affected URLs:</strong>
              ${Array.from(error.urls).map(url => `
                <div class="url-item">
                  <a href="${url}" target="_blank" rel="noopener">
                    ${url}
                  </a>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </div>
  
  <script>
    function toggleDetails(index) {
      const details = document.getElementById('details-' + index);
      details.classList.toggle('active');
    }
    
    // Search functionality
    document.getElementById('searchInput').addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const errorGroups = document.querySelectorAll('.error-group');
      
      errorGroups.forEach(group => {
        const errorText = group.dataset.error.toLowerCase();
        const errorTitle = group.querySelector('.error-title').textContent.toLowerCase();
        
        if (errorText.includes(searchTerm) || errorTitle.includes(searchTerm)) {
          group.style.display = 'block';
        } else {
          group.style.display = 'none';
        }
      });
    });
    
    // Sort functionality
    document.getElementById('sortSelect').addEventListener('change', (e) => {
      const sortBy = e.target.value;
      const container = document.querySelector('.errors');
      const errorGroups = Array.from(document.querySelectorAll('.error-group'));
      
      errorGroups.sort((a, b) => {
        const aCount = parseInt(a.querySelector('.badge.count').textContent);
        const bCount = parseInt(b.querySelector('.badge.count').textContent);
        const aUrls = parseInt(a.querySelector('.badge.urls').textContent);
        const bUrls = parseInt(b.querySelector('.badge.urls').textContent);
        
        switch(sortBy) {
          case 'count': return bCount - aCount;
          case 'urls': return bUrls - aUrls;
          default: return 0;
        }
      });
      
      errorGroups.forEach(group => container.appendChild(group));
    });
  </script>
</body>
</html>`;
    
    return html;
  }

  // Escape HTML for safe display
  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  // Generate JSON report
  async generateJsonReport() {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalUrlsScanned: this.processedUrls.size,
        uniqueErrors: this.errors.size,
        totalOccurrences: Array.from(this.errors.values()).reduce((sum, e) => sum + e.count, 0),
        affectedPages: this.urlErrors.size,
        errorRate: (this.urlErrors.size / this.processedUrls.size) * 100
      },
      errors: Array.from(this.errors.entries()).map(([key, error]) => ({
        normalizedKey: key,
        message: error.message,
        occurrences: error.count,
        affectedUrls: Array.from(error.urls),
        firstSeen: error.firstSeen,
        lastSeen: error.lastSeen,
        details: error.details
      })),
      urlErrors: Array.from(this.urlErrors.entries()).map(([url, errors]) => ({
        url,
        errors
      }))
    };
    
    return JSON.stringify(report, null, 2);
  }

  // Main run method
  async run() {
    console.log(`Starting error monitoring run at ${new Date().toISOString()}`);
    
    // Reset data
    this.errors.clear();
    this.urlErrors.clear();
    this.processedUrls.clear();
    
    // Generate URLs to check
    const urls = this.generateUrls();
    console.log(`Generated ${urls.length} URLs to check`);
    
    // Mark as processed
    urls.forEach(url => this.processedUrls.add(url));
    
    // Process all URLs
    const results = await this.processUrls(urls);
    
    // Generate reports
    await fs.mkdir(this.config.outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Save HTML report
    const htmlReport = await this.generateHtmlReport();
    const htmlPath = path.join(this.config.outputDir, `error-report-${timestamp}.html`);
    await fs.writeFile(htmlPath, htmlReport);
    
    // Save latest report
    const latestHtmlPath = path.join(this.config.outputDir, 'latest-report.html');
    await fs.writeFile(latestHtmlPath, htmlReport);
    
    // Save JSON report
    const jsonReport = await this.generateJsonReport();
    const jsonPath = path.join(this.config.outputDir, `error-report-${timestamp}.json`);
    await fs.writeFile(jsonPath, jsonReport);
    
    console.log(`Reports generated:`);
    console.log(`  HTML: ${htmlPath}`);
    console.log(`  JSON: ${jsonPath}`);
    console.log(`  Latest: ${latestHtmlPath}`);
    
    // Log summary
    console.log(`\nSummary:`);
    console.log(`  - Unique errors found: ${this.errors.size}`);
    console.log(`  - Total occurrences: ${Array.from(this.errors.values()).reduce((sum, e) => sum + e.count, 0)}`);
    console.log(`  - Affected pages: ${this.urlErrors.size}/${this.processedUrls.size}`);
    
    return {
      htmlPath,
      jsonPath,
      summary: {
        uniqueErrors: this.errors.size,
        totalOccurrences: Array.from(this.errors.values()).reduce((sum, e) => sum + e.count, 0),
        affectedPages: this.urlErrors.size
      }
    };
  }

  // Schedule recurring runs
  scheduleRuns() {
    // Run every 2 hours
    cron.schedule('0 */2 * * *', async () => {
      console.log('Starting scheduled error monitoring run...');
      try {
        await this.run();
      } catch (error) {
        console.error('Error during scheduled run:', error);
      }
    });
    
    console.log('Error monitoring scheduled to run every 2 hours');
  }
}

// Load URLs from external file if needed
async function loadUrlsFromFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').filter(url => url.trim());
  } catch (error) {
    console.error(`Error loading URLs from file: ${error.message}`);
    return [];
  }
}

// Main execution
async function main() {
  // Configuration
  const config = {
    baseUrls: [
      'https://www.salesforce.com',
      // Add more base URLs here
    ],
    confPatterns: ['/conf/', '/confirmation/', '/asyncconf'],
    locales: ['en-US'],
    maxConcurrent: 10,
    timeout: 30000,
    outputDir: './reports',
    retryLimit: 2
  };
  
  // You can also load URLs from a file
  // const additionalUrls = await loadUrlsFromFile('./urls.txt');
  
  const monitor = new ConsoleErrorMonitor(config);
  
  // Run immediately
  await monitor.run();
  
  // Schedule recurring runs
  monitor.scheduleRuns();
  
  // Keep the process running
  console.log('Monitor is running. Press Ctrl+C to stop.');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nGracefully shutting down...');
  process.exit(0);
});

// Run if this is the main module
if (require.main === module) {
  main().catch(console.error);
}

module.exports = ConsoleErrorMonitor;