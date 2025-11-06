const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const XLSX = require('xlsx');

puppeteer.use(StealthPlugin());

class ConsoleErrorMonitor {
  constructor(config = {}) {
    this.config = {
      baseUrls: config.baseUrls || ['https://www-qa1.salesforce.com'],
      maxConcurrent: config.maxConcurrent || 10,
      timeout: config.timeout || 30000,
      outputDir: config.outputDir || './reports',
      retryLimit: config.retryLimit || 2
    };
    
    this.pageErrors = new Map(); // Changed: Store errors by page
    this.processedUrls = new Set();
  }

  async generateUrls() {
    try {
      const workbook = XLSX.readFile('./combined_workbook_qa.xlsx');
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      const paths = data
        .map(row => row.path)
        .filter(path => path && typeof path === 'string')
        .map(path => `${this.config.baseUrls[0]}/${path.trim().replace(/^\//, '')}`);
      
      console.log(`Generated ${paths.length} URLs from Excel`);
      return paths;
    } catch (error) {
      console.error(`Error generating URLs: ${error.message}`);
      return [];
    }
  }

  async processUrl(browser, url) {
    let page;
    let retries = 0;
    
    while (retries <= this.config.retryLimit) {
      try {
        page = await browser.newPage();
        const errors = [];
        
        page.on('console', msg => {
          try {
            const type = msg.type();
            const text = msg.text ? msg.text() : msg.args()[0]?.toString() || '';
            
            if (type === 'error' || /Cross-Origin Request Blocked|ReferenceError: coveoua/.test(text)) {
              errors.push({
                text: text,
                location: msg.location?.() || {},
                type,
                timestamp: new Date().toISOString()
              });
            }
          } catch (e) {
            console.warn(`Error processing console message: ${e.message}`);
          }
        });
        
        page.on('pageerror', error => {
          errors.push({
            text: error.message,
            stack: error.stack,
            type: 'pageerror',
            timestamp: new Date().toISOString()
          });
        });
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: this.config.timeout });
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Store errors by page
        this.pageErrors.set(url, {
          url,
          errorCount: errors.length,
          errors: errors,
          scannedAt: new Date().toISOString(),
          success: true
        });
        
        await page.close();
        return { url, success: true, errorCount: errors.length };
      } catch (error) {
        if (page) await page.close().catch(() => {});
        if (++retries > this.config.retryLimit) {
          console.error(`Failed to process ${url}: ${error.message}`);
          
          // Store failure info
          this.pageErrors.set(url, {
            url,
            errorCount: 0,
            errors: [],
            scannedAt: new Date().toISOString(),
            success: false,
            failureReason: error.message
          });
          
          return { url, success: false, error: error.message };
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
    }
  }

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
    
    for (let i = 0; i < urls.length; i += this.config.maxConcurrent) {
      batches.push(urls.slice(i, i + this.config.maxConcurrent));
    }
    
    for (let i = 0; i < batches.length; i++) {
      console.log(`Processing batch ${i + 1}/${batches.length}`);
      
      const batchPromises = batches[i].map(url => 
        this.processUrl(browser, url)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      results.push(...batchResults.map(r => r.value || r.reason));
      
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    await browser.close();
    return results;
  }

// ... (all code before generateHtmlReport remains the same) ...

  async generateHtmlReport() {
    const timestamp = new Date().toISOString();
    
    // Sort pages by error count (descending), then alphabetically
    const sortedPages = Array.from(this.pageErrors.entries())
      .sort((a, b) => {
        if (b[1].errorCount !== a[1].errorCount) {
          return b[1].errorCount - a[1].errorCount;
        }
        return a[0].localeCompare(b[0]);
      });
    
    const totalErrors = sortedPages.reduce((sum, [, page]) => sum + page.errorCount, 0);
    const pagesWithErrors = sortedPages.filter(([, page]) => page.errorCount > 0).length;
    // Calculate failed pages for the summary stats
    const pagesFailed = sortedPages.filter(([, page]) => !page.success).length;

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
      flex-wrap: wrap;
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
    /* Added color for failed stat */
    .stat-number.failed {
        color: #d73027; /* Red for failed */
    }
    .stat-label {
      color: #666;
      margin-top: 5px;
    }
    .filter-bar {
      padding: 20px 30px;
      background: #fafafa;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      gap: 15px;
      align-items: center;
      flex-wrap: wrap;
    }
    input[type="search"] {
      flex: 1;
      min-width: 250px;
      padding: 10px 15px;
      border: 1px solid #ddd;
      border-radius: 5px;
      font-size: 1em;
    }
    select, button {
      padding: 10px 15px;
      border: 1px solid #ddd;
      border-radius: 5px;
      font-size: 1em;
      background: white;
      cursor: pointer;
    }
    button:hover {
      background: #f0f0f0;
    }
    .pages { padding: 30px; }
    .page-card {
      margin-bottom: 25px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      overflow: hidden;
      transition: box-shadow 0.3s;
    }
    .page-card:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .page-card.no-errors {
      border-color: #d1fae5; /* Green */
      background: #f0fdf4; /* Green */
    }
    .page-card.has-errors {
      /* CHANGED: Was red, now green to show load success */
      border-color: #d1fae5; /* Green */
      background: #f0fdf4; /* Green */
    }
    .page-card.failed {
      /* CHANGED: Was orange, now red to show load fail */
      border-color: #fecaca; /* Red */
      background: #fef2f2; /* Red */
    }
    .page-header {
      padding: 15px 20px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 15px;
    }
    .page-card.no-errors .page-header {
      background: #ecfdf5; /* Green */
    }
    .page-card.has-errors .page-header {
      /* CHANGED: Was red, now green */
      background: #ecfdf5; /* Green */
    }
    .page-card.failed .page-header {
      /* CHANGED: Was orange, now red */
      background: #fef2f2; /* Red */
    }
    .page-header:hover {
      opacity: 0.9;
    }
    .page-url {
      flex: 1;
      font-size: 0.95em;
      word-break: break-all;
      color: #2166ac;
    }
    .page-stats {
      display: flex;
      gap: 15px;
      align-items: center;
      flex-shrink: 0;
    }
    .badge {
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 0.85em;
      font-weight: bold;
      white-space: nowrap;
    }
    .badge.success {
      background: #d1fae5;
      color: #065f46;
    }
    .badge.errors {
      background: #fee0e0;
      color: #d73027;
    }
    .badge.failed {
      /* CHANGED: Was orange, now red */
      background: #fee0e0; /* Red */
      color: #d73027; /* Red */
    }
    .expand-icon {
      transition: transform 0.3s;
      font-size: 1.2em;
      color: #666;
    }
    .expand-icon.active {
      transform: rotate(180deg);
    }
    .page-details {
      padding: 20px;
      background: #fafafa;
      display: none;
      border-top: 1px solid #e0e0e0;
    }
    .page-details.active {
      display: block;
    }
    .error-list {
      margin-top: 15px;
    }
    .error-item {
      padding: 12px;
      background: white;
      margin-bottom: 10px;
      border-radius: 4px;
      border-left: 3px solid #dc2626;
    }
    .error-type {
      font-size: 0.85em;
      color: #666;
      margin-bottom: 5px;
      font-weight: bold;
    }
    .error-message {
      font-family: 'Courier New', monospace;
      font-size: 0.9em;
      color: #d73027;
      word-break: break-word;
      margin-bottom: 8px;
    }
    .error-meta {
      font-size: 0.8em;
      color: #666;
    }
    .failure-message {
      /* CHANGED: Updated color to be more prominent red */
      padding: 15px;
      background: #fef2f2; /* Light red */
      border: 1px solid #fecaca; /* Red border */
      border-radius: 4px;
      color: #991b1b; /* Dark red text */
      font-weight: 500;
    }
    .no-errors-msg {
      text-align: center;
      padding: 60px 30px;
      color: #666;
    }
    .no-errors-msg svg {
      width: 80px;
      height: 80px;
      margin-bottom: 20px;
      color: #4ade80;
    }
    .page-meta {
      font-size: 0.85em;
      color: #666;
      margin-bottom: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔍 Console Error Monitor Report</h1>
      <div class="meta">
        <div>📅 Generated: ${new Date(timestamp).toLocaleString()}</div>
        <div>🌐 Total Pages Scanned: ${this.processedUrls.size}</div>
        <div>⚠️ Pages with Errors: ${pagesWithErrors}</div>
        <div>❌ Pages Failed: ${pagesFailed}</div>
      </div>
    </header>
    
    <div class="summary">
      <div class="stat">
        <div class="stat-number">${this.processedUrls.size}</div>
        <div class="stat-label">Total Pages</div>
      </div>
      <div class="stat">
        <div class="stat-number">${pagesWithErrors}</div>
        <div class="stat-label">Pages with Errors</div>
      </div>
      <div class="stat">
        <div class="stat-number ${pagesFailed > 0 ? 'failed' : ''}">${pagesFailed}</div>
        <div class="stat-label">Pages Failed</div>
      </div>
      <div class="stat">
        <div class="stat-number">${totalErrors}</div>
        <div class="stat-label">Total Errors</div>
      </div>
    </div>
    
    <div class="filter-bar">
      <input type="search" id="searchInput" placeholder="Search pages or errors...">
      <select id="filterSelect">
        <option value="all">All Pages</option>
        <option value="errors">Pages with Errors</option>
        <option value="clean">Clean Pages</option>
        <option value="failed">Failed Pages</option>
      </select>
      <button id="expandAll">Expand All</button>
      <button id="collapseAll">Collapse All</button>
    </div>
    
    <div class="pages">
      ${sortedPages.length === 0 ? `
        <div class="no-errors-msg">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <h2>No Pages Scanned</h2>
        </div>
      ` : sortedPages.map(([url, pageData], index) => {
        // This logic is now simpler: 'failed' if not success, 'has-errors' if errors, 'no-errors' otherwise
        const cardClass = !pageData.success ? 'failed' : 
                          pageData.errorCount > 0 ? 'has-errors' : 'no-errors';
        
        return `
        <div class="page-card ${cardClass}" data-url="${url}" data-errors="${pageData.errorCount}">
          <div class="page-header" onclick="togglePageDetails(${index})">
            <div class="page-url">${this.escapeHtml(url)}</div>
            <div class="page-stats">
              ${!pageData.success ? 
                `<span class="badge failed">❌ Failed</span>` : // Changed badge text
                pageData.errorCount > 0 ? 
                `<span class="badge errors">${pageData.errorCount} error${pageData.errorCount !== 1 ? 's' : ''}</span>` :
                `<span class="badge success">✓ Clean</span>`
              }
              ${pageData.errorCount > 0 || !pageData.success ? 
                `<span class="expand-icon" id="icon-${index}">▼</span>` : ''
              }
            </div>
          </div>
          ${pageData.errorCount > 0 || !pageData.success ? `
          <div class="page-details" id="details-${index}">
            <div class="page-meta">
              <strong>Scanned:</strong> ${new Date(pageData.scannedAt).toLocaleString()}
            </div>
            
            ${!pageData.success ? `
              <div class="failure-message">
                <strong>⚠️ Failed to load page:</strong> ${this.escapeHtml(pageData.failureReason)}
              </div>
            ` : pageData.errorCount > 0 ? `
              <div class="error-list">
                <strong>Errors Found:</strong>
                ${pageData.errors.map((error, errIdx) => `
                  <div class="error-item">
                    <div class="error-type">${this.escapeHtml(error.type.toUpperCase())}</div>
                    <div class="error-message">${this.escapeHtml(error.text)}</div>
                    <div class="error-meta">
                      ${error.location && error.location.url ? 
                        `Location: ${this.escapeHtml(error.location.url)}${error.location.lineNumber ? `:${error.location.lineNumber}` : ''}<br>` : 
                        ''
                      }
                      Timestamp: ${new Date(error.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
          ` : ''}
        </div>
      `;
      }).join('')}
    </div>
  </div>
  
  <script>
    function togglePageDetails(index) {
      const details = document.getElementById('details-' + index);
      const icon = document.getElementById('icon-' + index);
      
      if (details) {
        details.classList.toggle('active');
        if (icon) icon.classList.toggle('active');
      }
    }
    
    // Search functionality
    document.getElementById('searchInput').addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const pageCards = document.querySelectorAll('.page-card');
      
      pageCards.forEach(card => {
        const url = card.dataset.url.toLowerCase();
        const errorTexts = Array.from(card.querySelectorAll('.error-message'))
          .map(el => el.textContent.toLowerCase())
          .join(' ');
        
        if (url.includes(searchTerm) || errorTexts.includes(searchTerm)) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    });
    
    // Filter functionality
    document.getElementById('filterSelect').addEventListener('change', (e) => {
      const filter = e.target.value;
      const pageCards = document.querySelectorAll('.page-card');
      
      pageCards.forEach(card => {
        const hasErrors = parseInt(card.dataset.errors) > 0;
        const hasFailed = card.classList.contains('failed');
        
        let show = false;
        switch(filter) {
          case 'all': show = true; break;
          case 'errors': show = hasErrors && !hasFailed; break;
          case 'clean': show = !hasErrors && !hasFailed; break;
          case 'failed': show = hasFailed; break;
        }
        
        card.style.display = show ? 'block' : 'none';
      });
    });
    
    // Expand/Collapse all
    document.getElementById('expandAll').addEventListener('click', () => {
      document.querySelectorAll('.page-details').forEach(el => el.classList.add('active'));
      document.querySelectorAll('.expand-icon').forEach(el => el.classList.add('active'));
    });
    
    document.getElementById('collapseAll').addEventListener('click', () => {
      document.querySelectorAll('.page-details').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.expand-icon').forEach(el => el.classList.remove('active'));
    });
  </script>
</body>
</html>`;
    
    return html;
  }

// ... (all code after generateHtmlReport remains the same) ...

  async generateJsonReport() {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalPagesScanned: this.processedUrls.size,
        pagesWithErrors: Array.from(this.pageErrors.values()).filter(p => p.errorCount > 0).length,
        totalErrors: Array.from(this.pageErrors.values()).reduce((sum, p) => sum + p.errorCount, 0),
        failedPages: Array.from(this.pageErrors.values()).filter(p => !p.success).length
      },
      pages: Array.from(this.pageErrors.entries()).map(([url, pageData]) => ({
        url,
        success: pageData.success,
        errorCount: pageData.errorCount,
        scannedAt: pageData.scannedAt,
        failureReason: pageData.failureReason || null,
        errors: pageData.errors
      }))
    };
    
    return JSON.stringify(report, null, 2);
  }

  async run() {
    console.log(`Starting error monitoring run at ${new Date().toISOString()}`);
    
    this.pageErrors.clear();
    this.processedUrls.clear();
    
    const urls = await this.generateUrls();
    urls.forEach(url => this.processedUrls.add(url));
    
    const results = await this.processUrls(urls);
    
    await fs.mkdir(this.config.outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    const htmlReport = await this.generateHtmlReport();
    const htmlPath = path.join(this.config.outputDir, `error-report-${timestamp}.html`);
    await fs.writeFile(htmlPath, htmlReport);
    
    const latestHtmlPath = path.join(this.config.outputDir, 'latest-report.html');
    await fs.writeFile(latestHtmlPath, htmlReport);
    
    const jsonReport = await this.generateJsonReport();
    const jsonPath = path.join(this.config.outputDir, `error-report-${timestamp}.json`);
    await fs.writeFile(jsonPath, jsonReport);
    
    console.log(`Reports generated:`);
    console.log(`  HTML: ${htmlPath}`);
    console.log(`  JSON: ${jsonPath}`);
    console.log(`  Latest: ${latestHtmlPath}`);
    
    const pagesWithErrors = Array.from(this.pageErrors.values()).filter(p => p.errorCount > 0).length;
    const totalErrors = Array.from(this.pageErrors.values()).reduce((sum, p) => sum + p.errorCount, 0);
    
    console.log(`\nSummary:`);
    console.log(`  - Pages scanned: ${this.processedUrls.size}`);
    console.log(`  - Pages with errors: ${pagesWithErrors}`);
    console.log(`  - Total errors: ${totalErrors}`);
    
    return {
      htmlPath,
      jsonPath,
      summary: {
        pagesScanned: this.processedUrls.size,
        pagesWithErrors,
        totalErrors
      }
    };
  }

  scheduleRuns() {
    cron.schedule('0 */2 * * *', () => this.run().catch(console.error));
    console.log('Monitoring scheduled every 2 hours');
    console.log('Monitor is running. Press Ctrl+C to stop.');
  }
}

if (require.main === module) {
  const monitor = new ConsoleErrorMonitor();
  monitor.run().then(() => monitor.scheduleRuns()).catch(error => {
    console.error('Failed:', error);
    process.exit(1);
  });
}

module.exports = ConsoleErrorMonitor;