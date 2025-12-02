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
        
        // --- OPTIMIZATION START: Block heavy resources ---
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const resourceType = req.resourceType();
          // Block images, fonts, media, and stylesheets to save bandwidth/CPU
          if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
            req.abort();
          } else {
            req.continue();
          }
        });
        // --- OPTIMIZATION END ---

        const errors = [];
        
        page.on('console', msg => {
          // ... (Existing console logic remains exactly the same) ...
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
          } catch (e) { /* ignore */ }
        });
        
        page.on('pageerror', error => {
           // ... (Existing pageerror logic remains exactly the same) ...
            errors.push({
            text: error.message,
            stack: error.stack,
            type: 'pageerror',
            timestamp: new Date().toISOString()
          });
        });
        
        // Reduced timeout overhead
        await page.goto(url, { waitUntil: 'networkidle2', timeout: this.config.timeout });
        
        // OPTIMIZATION: Reduced wait time. If networkidle2 fires, page is mostly ready.
        // Dropped from 5000ms to 2000ms.
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // ... (Remaining data collection logic remains exactly the same) ...
        
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
    // Define how many URLs to process before killing the browser instance
    const BROWSER_ROTATION_LIMIT = 50; 
    
    // Split all URLs into large chunks (e.g., 50 URLs per browser session)
    const browserChunks = [];
    for (let i = 0; i < urls.length; i += BROWSER_ROTATION_LIMIT) {
      browserChunks.push(urls.slice(i, i + BROWSER_ROTATION_LIMIT));
    }

    console.log(`Job split into ${browserChunks.length} browser sessions to prevent memory leaks.`);

    for (let chunkIndex = 0; chunkIndex < browserChunks.length; chunkIndex++) {
      const currentChunk = browserChunks[chunkIndex];
      console.log(`Starting Browser Session ${chunkIndex + 1}/${browserChunks.length} (Processing ${currentChunk.length} URLs)`);

      // Launch a FRESH browser for this chunk
      const browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          // REMOVED: '--single-process' (Causes instability over time)
        ]
      });

      try {
        // Process the chunk in small concurrent batches (defined in config.maxConcurrent)
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
          
          // Small cool-down between batches
          if (i < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } catch (err) {
        console.error("Critical error in browser session:", err);
      } finally {
        // Force close browser to release RAM
        await browser.close(); 
        // Force Garbage Collection if exposed (optional, but good practice)
        if (global.gc) { global.gc(); } 
      }
    }
    
    return results;
  }

  async generateHtmlReport() {
    const timestamp = new Date().toISOString();
    
    // 1. PREPARE DATA (Sorting & Organization)
    // We prepare raw data objects instead of HTML strings to save space.
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
        // Minimize error object size for JSON
        errors: data.errors.map(e => ({
          t: e.text, // Text
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

    // Calculate Summary Stats
    const summary = {
        total: this.processedUrls.size,
        withErrors: sortedPages.filter(p => p.errorCount > 0).length,
        failed: sortedPages.filter(p => p.status === 'failed').length,
        totalErrors: sortedPages.reduce((sum, p) => sum + p.errorCount, 0),
        uniqueErrors: sortedErrorGroups.length,
        generated: new Date(timestamp).toLocaleString()
    };

    // 2. GENERATE HTML SHELL
    // Note: We embed the data variable window.REPORT_DATA at the bottom.
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Console Error Report</title>
  <style>
    :root { --primary: #667eea; --secondary: #764ba2; --bg: #f5f5f5; --white: #fff; --border: #e0e0e0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: #333; line-height: 1.5; padding: 20px; }
    
    /* Layout */
    .container { max-width: 1400px; margin: 0 auto; background: var(--white); border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden; }
    header { background: linear-gradient(135deg, var(--primary), var(--secondary)); color: var(--white); padding: 25px; }
    h1 { font-size: 1.8rem; margin-bottom: 10px; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; font-size: 0.9rem; opacity: 0.9; }
    
    /* Summary Stats */
    .summary-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 20px; padding: 20px; background: #fafafa; border-bottom: 1px solid var(--border); }
    .stat-box { text-align: center; background: var(--white); padding: 15px; border-radius: 6px; border: 1px solid var(--border); }
    .stat-num { font-size: 2rem; font-weight: bold; color: var(--primary); }
    .stat-num.red { color: #dc2626; }
    .stat-label { font-size: 0.85rem; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }

    /* Navigation */
    .tabs { display: flex; background: #fafafa; border-bottom: 1px solid var(--border); }
    .tab-btn { flex: 1; padding: 15px; border: none; background: none; cursor: pointer; font-size: 1rem; color: #666; transition: 0.2s; border-bottom: 3px solid transparent; }
    .tab-btn:hover { background: #f0f0f0; }
    .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); background: var(--white); font-weight: 600; }
    
    /* Content Areas */
    .tab-content { display: none; padding: 20px; }
    .tab-content.active { display: block; }
    
    /* Filters */
    .controls { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    input, select, button.action-btn { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 0.9rem; }
    input { flex: 1; min-width: 200px; }
    button.action-btn { background: var(--white); cursor: pointer; }
    button.action-btn:hover { background: #f0f0f0; }

    /* Tables/Lists */
    .list-container { display: flex; flex-direction: column; gap: 10px; }
    .card { border: 1px solid var(--border); border-radius: 6px; background: var(--white); overflow: hidden; }
    .card-header { padding: 12px 15px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; background: #f8fafc; transition: background 0.2s; }
    .card-header:hover { background: #f1f5f9; }
    
    /* Card States */
    .card.success .card-header { border-left: 4px solid #10b981; }
    .card.error .card-header { border-left: 4px solid #f59e0b; }
    .card.failed .card-header { border-left: 4px solid #ef4444; background: #fef2f2; }
    
    .card-title { font-family: monospace; font-size: 0.95rem; color: #2563eb; flex: 1; word-break: break-all; margin-right: 15px; }
    .badges { display: flex; gap: 8px; align-items: center; }
    .badge { padding: 3px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; }
    .badge.green { background: #d1fae5; color: #065f46; }
    .badge.red { background: #fee2e2; color: #991b1b; }
    .badge.blue { background: #dbeafe; color: #1e40af; }
    
    .card-body { display: none; padding: 15px; border-top: 1px solid var(--border); background: #fff; }
    .card.expanded .card-body { display: block; }
    
    .error-row { border-left: 3px solid #dc2626; padding: 10px; background: #fafafa; margin-bottom: 8px; font-size: 0.9rem; }
    .err-msg { color: #dc2626; font-family: monospace; word-break: break-word; margin-bottom: 4px; }
    .err-loc { color: #666; font-size: 0.8rem; }
    
    /* Load More */
    .load-more-container { text-align: center; padding: 20px; }
    .load-btn { background: var(--primary); color: white; border: none; padding: 10px 30px; border-radius: 20px; cursor: pointer; font-size: 1rem; }
    .load-btn:hover { opacity: 0.9; }
    
    /* Simple Table */
    .data-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .data-table th, .data-table td { border: 1px solid #e2e8f0; padding: 8px; text-align: left; }
    .data-table th { background: #f8fafc; font-weight: 600; }
    .data-table tr:nth-child(even) { background: #f8fafc; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔍 Console Error Monitor</h1>
      <div class="meta-grid" id="header-meta"></div>
    </header>

    <div class="summary-bar" id="summary-bar">
      </div>

    <div class="tabs">
      <button id="tab-btn-pages" class="tab-btn active" onclick="app.switchTab('pages')">📄 Pages View</button>
      <button id="tab-btn-errors" class="tab-btn" onclick="app.switchTab('errors')">🔗 Errors Grouped</button>
      <button id="tab-btn-locs" class="tab-btn" onclick="app.switchTab('locs')">📍 Locations Table</button>
    </div>

    <div id="view-pages" class="tab-content active">
      <div class="controls">
        <input type="text" id="search-pages" placeholder="Search URL or Error text..." onkeyup="app.debounceSearch()">
        <select id="filter-pages" onchange="app.renderPages(true)">
          <option value="all">All Status</option>
          <option value="error">Has Errors</option>
          <option value="failed">Failed to Load</option>
          <option value="success">Clean</option>
        </select>
        <button class="action-btn" onclick="app.toggleAll('pages-list', true)">Expand All</button>
        <button class="action-btn" onclick="app.toggleAll('pages-list', false)">Collapse All</button>
      </div>
      <div id="pages-list" class="list-container"></div>
      <div class="load-more-container" id="pages-load-more" style="display:none">
        <button class="load-btn" onclick="app.renderPages(false)">Load More</button>
      </div>
    </div>

    <div id="view-errors" class="tab-content">
      <div class="controls">
        <input type="text" id="search-groups" placeholder="Search error text..." onkeyup="app.debounceSearchGroups()">
      </div>
      <div id="groups-list" class="list-container"></div>
    </div>

    <div id="view-locs" class="tab-content">
      <div style="overflow-x: auto;">
        <table class="data-table">
          <thead><tr><th>Error Message</th><th>Location</th><th>Count</th></tr></thead>
          <tbody id="locs-body"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    window.REPORT_DATA = ${JSON.stringify({ summary, pages: sortedPages, groups: sortedErrorGroups })};
  </script>

  <script>
    const app = {
      data: window.REPORT_DATA,
      state: {
        pageLimit: 50,
        pageOffset: 0,
        activeTab: 'pages',
        filteredPages: []
      },

      init() {
        this.renderHeader();
        this.renderSummary();
        // Initial Filter
        this.filterPages(); 
        this.renderPages(true);
        this.renderGroups();
        this.renderLocs();
      },

      // --- RENDERERS ---

      renderHeader() {
        const d = this.data.summary;
        document.getElementById('header-meta').innerHTML = \`
          <div>📅 Generated: \${d.generated}</div>
          <div>🌐 Total Pages: \${d.total}</div>
        \`;
      },

      renderSummary() {
        const d = this.data.summary;
        document.getElementById('summary-bar').innerHTML = \`
          <div class="stat-box"><div class="stat-num">\${d.total}</div><div class="stat-label">Scanned</div></div>
          <div class="stat-box"><div class="stat-num \${d.withErrors>0?'red':''} ">\${d.withErrors}</div><div class="stat-label">With Errors</div></div>
          <div class="stat-box"><div class="stat-num \${d.failed>0?'red':''} ">\${d.failed}</div><div class="stat-label">Failed</div></div>
          <div class="stat-box"><div class="stat-num">\${d.totalErrors}</div><div class="stat-label">Total Logs</div></div>
        \`;
      },

      renderPages(reset = false) {
        if (reset) {
           this.state.pageOffset = 0;
           document.getElementById('pages-list').innerHTML = '';
           this.filterPages();
        }

        const container = document.getElementById('pages-list');
        const slice = this.state.filteredPages.slice(this.state.pageOffset, this.state.pageOffset + this.state.pageLimit);
        
        const html = slice.map((p, idx) => {
          // Unique ID for toggle
          const uid = this.state.pageOffset + idx;
          const badge = p.status === 'failed' ? '<span class="badge red">FAILED</span>' :
                        p.status === 'error' ? \`<span class="badge red">\${p.errorCount} Errors</span>\` :
                        '<span class="badge green">CLEAN</span>';
          
          let bodyContent = '';
          if (p.status === 'failed') {
            bodyContent = \`<div class="error-row"><strong>Failure Reason:</strong> \${this.escape(p.failureReason)}</div>\`;
          } else if (p.status === 'error') {
            bodyContent = p.errors.map(e => \`
              <div class="error-row">
                <div class="err-msg">\${this.escape(e.t)}</div>
                <div class="err-loc">\${e.l ? '📍 ' + this.escape(e.l) : ''}</div>
              </div>
            \`).join('');
          } else {
             bodyContent = '<div style="color:#aaa; text-align:center; padding:10px;">No errors detected</div>';
          }

          return \`
            <div class="card \${p.status}" id="p-card-\${uid}">
              <div class="card-header" onclick="app.toggleCard('p-card-\${uid}')">
                <div class="card-title">\${this.escape(p.url)}</div>
                <div class="badges">\${badge} \${p.status!=='success'?'▼':''}</div>
              </div>
              <div class="card-body">\${bodyContent}</div>
            </div>
          \`;
        }).join('');

        container.insertAdjacentHTML('beforeend', html);
        
        this.state.pageOffset += slice.length;
        
        // Handle "Load More" button visibility
        const btn = document.getElementById('pages-load-more');
        btn.style.display = this.state.pageOffset < this.state.filteredPages.length ? 'block' : 'none';
      },

      renderGroups() {
        const container = document.getElementById('groups-list');
        // Simple optimization: only render top 200 groups to avoid lag, usually enough
        const html = this.data.groups.slice(0, 200).map((g, idx) => {
           return \`
            <div class="card error" id="g-card-\${idx}">
              <div class="card-header" onclick="app.toggleCard('g-card-\${idx}')">
                <div class="card-title" style="color:#dc2626">\${this.escape(g.text)}</div>
                <div class="badges"><span class="badge blue">\${g.count} Pages</span> ▼</div>
              </div>
              <div class="card-body">
                <div style="margin-bottom:10px; font-weight:bold; color:#666">Location: \${this.escape(g.loc)}</div>
                <div style="max-height: 200px; overflow-y:auto; background:#f8f8f8; padding:10px;">
                  \${g.pages.map(u => \`<div><a href="#" onclick="app.jumpToPage('\${u}'); return false;">\${this.escape(u)}</a></div>\`).join('')}
                </div>
              </div>
            </div>
           \`;
        }).join('');
        container.innerHTML = html || '<div style="text-align:center; padding:20px;">No errors found</div>';
      },

      renderLocs() {
         const tbody = document.getElementById('locs-body');
         // Unique check based on Signature
         const html = this.data.groups.map(g => \`
            <tr>
              <td>\${this.escape(g.text)}</td>
              <td>\${this.escape(g.loc)}</td>
              <td>\${g.count}</td>
            </tr>
         \`).join('');
         tbody.innerHTML = html;
      },

      // --- LOGIC ---

      filterPages() {
        const search = document.getElementById('search-pages').value.toLowerCase();
        const type = document.getElementById('filter-pages').value;
        
        this.state.filteredPages = this.data.pages.filter(p => {
          // Status Filter
          if (type === 'error' && p.status !== 'error') return false;
          if (type === 'failed' && p.status !== 'failed') return false;
          if (type === 'success' && p.status !== 'success') return false;
          
          // Search Filter
          if (!search) return true;
          const urlMatch = p.url.toLowerCase().includes(search);
          const errMatch = p.errors && p.errors.some(e => e.t.toLowerCase().includes(search));
          return urlMatch || errMatch;
        });
      },

      switchTab(tabName) {
        // Reset buttons
        ['pages', 'errors', 'locs'].forEach(t => {
          document.getElementById('tab-btn-' + t).classList.remove('active');
          document.getElementById('view-' + t).classList.remove('active');
        });
        
        // Activate target
        document.getElementById('tab-btn-' + tabName).classList.add('active');
        document.getElementById('view-' + tabName).classList.add('active');
      },

      toggleCard(id) {
        document.getElementById(id).classList.toggle('expanded');
      },

      toggleAll(containerId, expand) {
        const cards = document.getElementById(containerId).querySelectorAll('.card');
        cards.forEach(c => expand ? c.classList.add('expanded') : c.classList.remove('expanded'));
      },

      jumpToPage(url) {
        this.switchTab('pages');
        document.getElementById('search-pages').value = url;
        this.filterPages();
        this.renderPages(true);
      },

      debounceSearch() {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.renderPages(true), 300);
      },

      debounceSearchGroups() {
         // Simple filter for groups (not fully implemented in renderGroups for brevity, but easy to add)
         const term = document.getElementById('search-groups').value.toLowerCase();
         const cards = document.getElementById('groups-list').children;
         Array.from(cards).forEach(card => {
            const txt = card.innerText.toLowerCase();
            card.style.display = txt.includes(term) ? 'block' : 'none';
         });
      },

      escape(str) {
        if (!str) return '';
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
      }
    };

    // Start
    app.init();
  </script>
</body>
</html>
    `;
    
    return html;
  }

  async generateJsonReport() {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalPagesScanned: this.processedUrls.size,
        pagesWithErrors: Array.from(this.pageErrors.values()).filter(p => p.errorCount > 0).length,
        totalErrors: Array.from(this.pageErrors.values()).reduce((sum, p) => sum + p.errorCount, 0),
        failedPages: Array.from(this.pageErrors.values()).filter(p => !p.success).length,
        uniqueErrors: this.errorGroups.size
      },
      errorGroups: Array.from(this.errorGroups.entries()).map(([signature, group]) => ({
        signature,
        errorText: group.errorText,
        errorLocation: group.errorLocation,
        affectedPagesCount: group.pages.size,
        affectedPages: Array.from(group.pages),
        sampleError: group.sampleError
      })),
      pages: Array.from(this.pageErrors.entries()).map(([url, pageData]) => ({
        url,
        success: pageData.success,
        errorCount: pageData.errorCount,
        uniqueErrorCount: new Set(pageData.errors.map(e => this.getErrorSignature(e))).size,
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