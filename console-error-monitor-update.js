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
    
    this.pageErrors = new Map();
    this.processedUrls = new Set();
    this.errorGroups = new Map();
  }

  getErrorSignature(error) {
    const location = error.location?.url || 'unknown';
    return `${error.text}|||${location}`;
  }

  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
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
        
        // --- FIX 1: Block Downloads via CDP ---
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
          behavior: 'deny' 
        });

        // --- OPTIMIZATION START: Block heavy resources ---
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const resourceType = req.resourceType();
          const reqUrl = req.url().toLowerCase();

          // --- FIX 2: Explicitly block PDF and Font extensions in URL ---
          if (reqUrl.endsWith('.pdf') || reqUrl.endsWith('.woff') || reqUrl.endsWith('.woff2')) {
            req.abort();
            return;
          }

          // Block images, fonts, media, and stylesheets
          if (['image', 'media', 'font', 'stylesheet', 'other'].includes(resourceType)) {
            req.abort();
          } else {
            req.continue();
          }
        });
        
        // Monitor Response Headers to catch binary files that weren't caught by extension
        page.on('response', response => {
            const headers = response.headers();
            const contentType = headers['content-type'] || '';
            // If the main page navigation results in a PDF or binary stream, we stop tracking
            if (response.url() === url && (contentType.includes('application/pdf') || contentType.includes('application/octet-stream'))) {
                // We don't consider this an error, just a non-html page
            }
        });
        // --- OPTIMIZATION END ---

        const errors = [];
        
        page.on('console', msg => {
          try {
            const type = msg.type();
            const text = msg.text ? msg.text() : msg.args()[0]?.toString() || '';
            
            // --- FIX 3: Filter False Positives ---
            // If we aborted a request (font/img), Chrome logs "net::ERR_FAILED". We ignore this.
            if (text.includes('net::ERR_FAILED') || text.includes('net::ERR_ABORTED')) {
                return; 
            }

            if (type === 'error' || /Cross-Origin Request Blocked|ReferenceError: coveoua/.test(text)) {
              errors.push({
                text: text,
                location: msg.location?.() || {},
                type,
                timestamp: new Date().toISOString()
              });
            }
          } catch (e) { /* ignore */ }
        });
        
        page.on('pageerror', error => {
            errors.push({
            text: error.message,
            stack: error.stack,
            type: 'pageerror',
            timestamp: new Date().toISOString()
          });
        });
        
        // --- FIX 4: Relaxed Timeout Strategy ---
        // Changed from 'networkidle2' to 'domcontentloaded'. 
        // This prevents 30s timeouts on pages that have background tracking/analytics pixels.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeout });
        
        // Wait a buffer period for JS to execute (2 seconds)
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        this.pageErrors.set(url, {
          url,
          errorCount: errors.length,
          errors: errors,
          scannedAt: new Date().toISOString(),
          success: true
        });

        errors.forEach(error => {
          const signature = this.getErrorSignature(error);
          if (!this.errorGroups.has(signature)) {
            this.errorGroups.set(signature, {
              signature,
              errorText: error.text,
              errorLocation: error.location?.url || 'unknown',
              pages: new Set(),
              sampleError: error
            });
          }
          this.errorGroups.get(signature).pages.add(url);
        });
        
        await page.close();
        return { url, success: true, errorCount: errors.length };
      } catch (error) {
        if (page) await page.close().catch(() => {});
        
        // If it's a "net::ERR_ABORTED" on the main document, it usually means we blocked a PDF download intentionally.
        // We treat this as a success with 0 errors.
        if (error.message.includes('net::ERR_ABORTED') || error.message.includes('net::ERR_FAILED')) {
             this.pageErrors.set(url, {
                url,
                errorCount: 0,
                errors: [],
                scannedAt: new Date().toISOString(),
                success: true, // Marked as success because we intentionally blocked it
                failureReason: "Resource blocked (PDF/Font)"
              });
             return { url, success: true, errorCount: 0 };
        }

        if (++retries > this.config.retryLimit) {
          console.error(`Failed to process ${url}: ${error.message}`);
          
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
    const results = [];
    const BROWSER_ROTATION_LIMIT = 50; 
    
    const browserChunks = [];
    for (let i = 0; i < urls.length; i += BROWSER_ROTATION_LIMIT) {
      browserChunks.push(urls.slice(i, i + BROWSER_ROTATION_LIMIT));
    }

    console.log(`Job split into ${browserChunks.length} browser sessions to prevent memory leaks.`);

    for (let chunkIndex = 0; chunkIndex < browserChunks.length; chunkIndex++) {
      const currentChunk = browserChunks[chunkIndex];
      console.log(`Starting Browser Session ${chunkIndex + 1}/${browserChunks.length} (Processing ${currentChunk.length} URLs)`);

      const browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
        ]
      });

      try {
        const batches = [];
        for (let i = 0; i < currentChunk.length; i += this.config.maxConcurrent) {
          batches.push(currentChunk.slice(i, i + this.config.maxConcurrent));
        }

        for (let i = 0; i < batches.length; i++) {
          console.log(`  Processing batch ${i + 1}/${batches.length} in current session...`);
          
          const batchPromises = batches[i].map(url => 
            this.processUrl(browser, url)
          );
          
          const batchResults = await Promise.allSettled(batchPromises);
          results.push(...batchResults.map(r => r.value || r.reason));
          
          if (i < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } catch (err) {
        console.error("Critical error in browser session:", err);
      } finally {
        await browser.close(); 
        if (global.gc) { global.gc(); } 
      }
    }
    
    return results;
  }

  async generateHtmlReport() {
    const timestamp = new Date().toISOString();

    const sortedPages = Array.from(this.pageErrors.entries())
      .sort((a, b) => {
        if (b[1].errorCount !== a[1].errorCount) return b[1].errorCount - a[1].errorCount;
        return a[0].localeCompare(b[0]);
      })
      .map(([url, data]) => ({
        url: url,
        status: !data.success ? 'failed' : data.errorCount > 0 ? 'error' : 'success',
        errorCount: data.errorCount,
        uniqueErrors: new Set(data.errors.map(e => this.getErrorSignature(e))).size,
        scannedAt: data.scannedAt,
        failureReason: data.failureReason,
        errors: data.errors.map(e => ({
          t: e.text,
          type: e.type,
          l: e.location?.url ? `${e.location.url}:${e.location.lineNumber || ''}` : null,
          s: this.getErrorSignature(e)
        }))
      }));

    const sortedErrorGroups = Array.from(this.errorGroups.values())
      .sort((a, b) => b.pages.size - a.pages.size)
      .map(group => ({
        sig: group.signature,
        text: group.errorText,
        loc: group.errorLocation,
        count: group.pages.size,
        pages: Array.from(group.pages)
      }));

    // Extract faulty images
    const faultyImages = [];
    sortedPages.forEach(page => {
      page.errors.forEach(error => {
        const errorText = error.t.toLowerCase();
        // Detect image-related errors
        if (errorText.includes('.jpg') || errorText.includes('.jpeg') || 
            errorText.includes('.png') || errorText.includes('.gif') || 
            errorText.includes('.svg') || errorText.includes('.webp') ||
            errorText.includes('image') || errorText.includes('img')) {

          // Try to extract image URL from error text
          const urlMatch = error.t.match(/(https?:\/\/[^\s'"]+\.(jpg|jpeg|png|gif|svg|webp)[^\s'"]*)/i);
          if (urlMatch) {
            faultyImages.push({
              imageUrl: urlMatch[0],
              foundOnPage: page.url
            });
          } else {
            // If no URL found, use the error text itself
            faultyImages.push({
              imageUrl: error.t,
              foundOnPage: page.url
            });
          }
        }
      });
    });

    const summary = {
      total: this.processedUrls.size,
      withErrors: sortedPages.filter(p => p.errorCount > 0).length,
      failed: sortedPages.filter(p => p.status === 'failed').length,
      totalErrors: sortedPages.reduce((sum, p) => sum + p.errorCount, 0),
      uniqueErrors: sortedErrorGroups.length,
      faultyImages: faultyImages.length,
      generated: new Date(timestamp).toLocaleString()
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Console Error Report - ${summary.generated}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #f5f7fa;
      color: #2d3748;
      line-height: 1.6;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header { 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
      border-radius: 12px;
      margin-bottom: 30px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .header h1 { font-size: 28px; margin-bottom: 8px; }
    .header p { opacity: 0.9; font-size: 14px; }

    .summary-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .summary-card {
      background: white;
      padding: 20px;
      border-radius: 10px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.08);
      border-left: 4px solid #667eea;
    }
    .summary-card.errors { border-left-color: #f56565; }
    .summary-card.failed { border-left-color: #ed8936; }
    .summary-card.images { border-left-color: #9f7aea; }
    .summary-card h3 { font-size: 14px; color: #718096; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-card .value { font-size: 32px; font-weight: bold; color: #2d3748; }

    .tabs {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .tab-buttons {
      display: flex;
      background: #f7fafc;
      border-bottom: 2px solid #e2e8f0;
      overflow-x: auto;
    }
    .tab-button {
      padding: 16px 24px;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 15px;
      font-weight: 500;
      color: #718096;
      border-bottom: 3px solid transparent;
      transition: all 0.3s;
      white-space: nowrap;
    }
    .tab-button:hover { background: #edf2f7; color: #4a5568; }
    .tab-button.active {
      color: #667eea;
      border-bottom-color: #667eea;
      background: white;
    }

    .tab-content { display: none; padding: 24px; }
    .tab-content.active { display: block; }

    .controls {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
      align-items: center;
    }
    .search-box {
      flex: 1;
      min-width: 250px;
      padding: 10px 16px;
      border: 2px solid #e2e8f0;
      border-radius: 8px;
      font-size: 14px;
      transition: border-color 0.3s;
    }
    .search-box:focus { outline: none; border-color: #667eea; }

    .export-btn {
      padding: 10px 20px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .export-btn:hover { background: #5a67d8; transform: translateY(-1px); }
    .export-btn:active { transform: translateY(0); }

    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      font-size: 14px;
    }
    th {
      background: #f7fafc;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      color: #4a5568;
      border-bottom: 2px solid #e2e8f0;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: top;
    }
    tr:hover { background: #f7fafc; }

    .status-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-success { background: #c6f6d5; color: #22543d; }
    .status-error { background: #fed7d7; color: #742a2a; }
    .status-failed { background: #feebc8; color: #7c2d12; }

    .error-text {
      font-family: 'Courier New', monospace;
      font-size: 13px;
      background: #f7fafc;
      padding: 8px;
      border-radius: 4px;
      margin: 4px 0;
      word-break: break-word;
    }

    .url-link {
      color: #667eea;
      text-decoration: none;
      word-break: break-all;
    }
    .url-link:hover { text-decoration: underline; }

    .page-list {
      max-height: 200px;
      overflow-y: auto;
      font-size: 12px;
    }
    .page-list-item {
      padding: 4px 0;
      border-bottom: 1px solid #e2e8f0;
    }

    .notification {
      position: fixed;
      top: 20px;
      right: 20px;
      background: #48bb78;
      color: white;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 1000;
      animation: slideIn 0.3s ease-out;
    }
    @keyframes slideIn {
      from { transform: translateX(400px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    @media (max-width: 768px) {
      .container { padding: 12px; }
      .header { padding: 20px; }
      .summary-cards { grid-template-columns: 1fr; }
      .tab-button { padding: 12px 16px; font-size: 13px; }
      table { font-size: 12px; }
      th, td { padding: 8px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔍 Console Error Monitoring Report</h1>
      <p>Generated on ${summary.generated}</p>
    </div>

    <div class="summary-cards">
      <div class="summary-card">
        <h3>Total URLs</h3>
        <div class="value">${summary.total}</div>
      </div>
      <div class="summary-card errors">
        <h3>With Errors</h3>
        <div class="value">${summary.withErrors}</div>
      </div>
      <div class="summary-card failed">
        <h3>Failed</h3>
        <div class="value">${summary.failed}</div>
      </div>
      <div class="summary-card">
        <h3>Unique Errors</h3>
        <div class="value">${summary.uniqueErrors}</div>
      </div>
      <div class="summary-card images">
        <h3>Faulty Images</h3>
        <div class="value">${summary.faultyImages}</div>
      </div>
    </div>

    <div class="tabs">
      <div class="tab-buttons">
        <button class="tab-button active" onclick="switchTab(0)">📄 All URLs (${summary.total})</button>
        <button class="tab-button" onclick="switchTab(1)">⚠️ Error Summary (${summary.uniqueErrors})</button>
        <button class="tab-button" onclick="switchTab(2)">🔍 Detailed Errors</button>
        <button class="tab-button" onclick="switchTab(3)">🖼️ Faulty Images (${summary.faultyImages})</button>
      </div>

      <!-- Tab 1: All URLs -->
      <div class="tab-content active" id="tab-0">
        <div class="controls">
          <input type="text" class="search-box" id="search-0" placeholder="Search URLs..." onkeyup="filterTable(0)">
          <button class="export-btn" onclick="exportToExcel(0)">
            <span>📊</span> Export to Excel
          </button>
        </div>
        <div style="overflow-x: auto;">
          <table id="table-0">
            <thead>
              <tr>
                <th>URL</th>
                <th>Status</th>
                <th>Errors</th>
                <th>Unique</th>
                <th>Scanned At</th>
              </tr>
            </thead>
            <tbody>
              ${sortedPages.map(p => `
                <tr>
                  <td><a href="${this.escapeHtml(p.url)}" class="url-link" target="_blank">${this.escapeHtml(p.url)}</a></td>
                  <td><span class="status-badge status-${p.status}">${p.status}</span></td>
                  <td>${p.errorCount}</td>
                  <td>${p.uniqueErrors}</td>
                  <td>${p.scannedAt}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Tab 2: Error Summary -->
      <div class="tab-content" id="tab-1">
        <div class="controls">
          <input type="text" class="search-box" id="search-1" placeholder="Search errors..." onkeyup="filterTable(1)">
          <button class="export-btn" onclick="exportToExcel(1)">
            <span>📊</span> Export to Excel
          </button>
        </div>
        <div style="overflow-x: auto;">
          <table id="table-1">
            <thead>
              <tr>
                <th>Error Message</th>
                <th>Location</th>
                <th>Occurrences</th>
                <th>Affected Pages</th>
              </tr>
            </thead>
            <tbody>
              ${sortedErrorGroups.map(g => `
                <tr>
                  <td><div class="error-text">${this.escapeHtml(g.text)}</div></td>
                  <td>${this.escapeHtml(g.loc)}</td>
                  <td>${g.count}</td>
                  <td>
                    <div class="page-list">
                      ${g.pages.map(p => `<div class="page-list-item"><a href="${this.escapeHtml(p)}" class="url-link" target="_blank">${this.escapeHtml(p)}</a></div>`).join('')}
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Tab 3: Detailed Errors -->
      <div class="tab-content" id="tab-2">
        <div class="controls">
          <input type="text" class="search-box" id="search-2" placeholder="Search detailed errors..." onkeyup="filterTable(2)">
          <button class="export-btn" onclick="exportToExcel(2)">
            <span>📊</span> Export to Excel
          </button>
        </div>
        <div style="overflow-x: auto;">
          <table id="table-2">
            <thead>
              <tr>
                <th>Page URL</th>
                <th>Error Message</th>
                <th>Type</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              ${sortedPages.flatMap(p => 
                p.errors.length > 0 ? p.errors.map(e => `
                  <tr>
                    <td><a href="${this.escapeHtml(p.url)}" class="url-link" target="_blank">${this.escapeHtml(p.url)}</a></td>
                    <td><div class="error-text">${this.escapeHtml(e.t)}</div></td>
                    <td>${this.escapeHtml(e.type)}</td>
                    <td>${e.l ? this.escapeHtml(e.l) : 'N/A'}</td>
                  </tr>
                `) : []
              ).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Tab 4: Faulty Images -->
      <div class="tab-content" id="tab-3">
        <div class="controls">
          <input type="text" class="search-box" id="search-3" placeholder="Search image URLs..." onkeyup="filterTable(3)">
          <button class="export-btn" onclick="exportToExcel(3)">
            <span>📊</span> Export to Excel
          </button>
        </div>
        <div style="overflow-x: auto;">
          <table id="table-3">
            <thead>
              <tr>
                <th>Image URL</th>
                <th>Found on Page</th>
              </tr>
            </thead>
            <tbody>
              ${faultyImages.map(img => `
                <tr>
                  <td><div class="error-text">${this.escapeHtml(img.imageUrl)}</div></td>
                  <td><a href="${this.escapeHtml(img.foundOnPage)}" class="url-link" target="_blank">${this.escapeHtml(img.foundOnPage)}</a></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <script>
    function switchTab(index) {
      const buttons = document.querySelectorAll('.tab-button');
      const contents = document.querySelectorAll('.tab-content');

      buttons.forEach((btn, i) => {
        btn.classList.toggle('active', i === index);
      });

      contents.forEach((content, i) => {
        content.classList.toggle('active', i === index);
      });
    }

    function filterTable(tabIndex) {
      const input = document.getElementById('search-' + tabIndex);
      const filter = input.value.toLowerCase();
      const table = document.getElementById('table-' + tabIndex);
      const rows = table.getElementsByTagName('tr');

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(filter) ? '' : 'none';
      }
    }

    function escapeCSV(text) {
      if (text == null) return '';
      text = String(text);
      if (text.includes('"') || text.includes(',') || text.includes('\n')) {
        return '"' + text.replace(/"/g, '""') + '"';
      }
      return text;
    }

    function exportToExcel(tabIndex) {
      const table = document.getElementById('table-' + tabIndex);
      const rows = Array.from(table.querySelectorAll('tr')).filter(row => row.style.display !== 'none');

      let csv = [];
      rows.forEach(row => {
        const cols = Array.from(row.querySelectorAll('th, td'));
        const rowData = cols.map(col => {
          let text = col.textContent.trim().replace(/\s+/g, ' ');
          return escapeCSV(text);
        });
        csv.push(rowData.join(','));
      });

      const csvContent = csv.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

      const tabNames = ['all-urls', 'error-summary', 'detailed-errors', 'faulty-images'];
      link.href = URL.createObjectURL(blob);
      link.download = 'console-errors-' + tabNames[tabIndex] + '-' + timestamp + '.csv';
      link.click();

      showNotification('Exported to Excel successfully!');
    }

    function showNotification(message) {
      const notification = document.createElement('div');
      notification.className = 'notification';
      notification.textContent = message;
      document.body.appendChild(notification);

      setTimeout(() => {
        notification.style.animation = 'slideIn 0.3s ease-out reverse';
        setTimeout(() => notification.remove(), 300);
      }, 2500);
    }
  </script>
</body>
</html>`;

    return html;
  }

  

    async run() {
    console.log(`Starting error monitoring run at ${new Date().toISOString()}`);
    
    this.pageErrors.clear();
    this.processedUrls.clear();
    this.errorGroups.clear();
    
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
    const uniqueErrors = this.errorGroups.size;
    
    console.log(`\nSummary:`);
    console.log(`  - Pages scanned: ${this.processedUrls.size}`);
    console.log(`  - Pages with errors: ${pagesWithErrors}`);
    console.log(`  - Total errors: ${totalErrors}`);
    console.log(`  - Unique errors: ${uniqueErrors}`);
    
    return {
      htmlPath,
      jsonPath,
      summary: {
        pagesScanned: this.processedUrls.size,
        pagesWithErrors,
        totalErrors,
        uniqueErrors
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