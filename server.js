import express from 'express'
import cors from 'cors'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, extname } from 'path'
import { createRequire } from 'module'
import ExcelJS from 'exceljs'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

// ── 코어덤프 비활성화 (디스크 낭비 방지) ──────────────
try { process.setrlimit('core', { soft: 0, hard: 0 }) } catch(_) {}

// ── 전역 예외 핸들러 (서버가 크래시로 죽지 않도록) ────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] 처리되지 않은 예외 (서버 계속 실행):', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] 처리되지 않은 Promise 거부 (서버 계속 실행):', reason?.message || reason)
})

const require = createRequire(import.meta.url)
const multer  = require('multer')
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// multer: 메모리에 파일 보관 (각 파일 최대 5MB, 전체 500파일)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 500 },
  fileFilter: (req, file, cb) => {
    if (/\.(html?|jsp|asp|php)$/i.test(file.originalname)) cb(null, true)
    else cb(null, false)
  }
})

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.static(join(__dirname, 'public')))

// axe-core 소스 서버 시작 시 1회만 로드 (캐싱 → 매 스캔 I/O 제거)
const AXE_SOURCE = readFileSync(join(__dirname, 'node_modules/axe-core/axe.min.js'), 'utf8')

// ─────────────────────────────────────────────────────
// 브라우저 풀 (배치 스캔에서 매번 launch/close 하지 않고 재사용)
// ─────────────────────────────────────────────────────
// ⚠️ RAM 987MB 환경: 브라우저 1개당 150~200MB → 풀 3개가 최대 안전치
// 브라우저 3개 × 200MB = 600MB + Node.js 150MB = 750MB (< 987MB 한계)
const BROWSER_POOL_SIZE = 3       // 동시 유지 브라우저 수 (메모리 제한으로 3개)
const BATCH_CONCURRENCY = 3       // 배치 동시 처리 수 (메모리 제한으로 3개)
const BROWSER_MAX_USES  = 30      // 재사용 횟수 초과 시 교체 (메모리 누수 방지)
const MAX_EVIDENCE_STORE = 5000   // evidenceStore 최대 보관 수 (메모리 제한)

class BrowserPool {
  constructor(size = BROWSER_POOL_SIZE) {
    this.size = size
    this.pool = []    // { browser, uses, busy }
    this.queue = []   // 대기 Promise resolve 목록
  }

  async _launch() {
    const browser = await chromium.launch({
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-extensions', '--disable-background-networking',
        '--disable-default-apps', '--disable-sync', '--disable-translate',
        '--hide-scrollbars', '--metrics-recording-only', '--mute-audio',
        '--no-first-run', '--safebrowsing-disable-auto-update',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-software-rasterizer', '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection', '--disable-hang-monitor',
        '--disable-prompt-on-repost', '--disable-domain-reliability',
        '--disable-component-update', '--disable-client-side-phishing-detection',
        '--js-flags=--max-old-space-size=128'   // 브라우저당 JS 힙 제한 128MB
      ]
    })
    return { browser, uses: 0, busy: false }
  }

  async acquire() {
    // 빈 슬롯 찾기
    let slot = this.pool.find(s => !s.busy)
    if (!slot && this.pool.length < this.size) {
      slot = await this._launch()
      this.pool.push(slot)
    }
    if (slot) {
      slot.busy = true
      return slot
    }
    // 모두 사용 중 → 대기
    return new Promise(resolve => this.queue.push(resolve))
  }

  async release(slot) {
    slot.uses++
    slot.busy = false
    // 과다 사용 슬롯은 교체
    if (slot.uses >= BROWSER_MAX_USES) {
      const idx = this.pool.indexOf(slot)
      if (idx !== -1) {
        this.pool.splice(idx, 1)
        slot.browser.close().catch(() => {})
      }
    }
    // 대기 중인 요청 처리
    if (this.queue.length > 0) {
      const next = this.queue.shift()
      const newSlot = await this._launch().catch(async () => {
        // 런칭 실패 시 기존 슬롯 하나를 강제 해제
        const free = this.pool.find(s => !s.busy)
        if (free) { free.busy = true; return free }
        return null
      })
      if (newSlot) {
        this.pool.push(newSlot)
        newSlot.busy = true
        next(newSlot)
      }
    }
  }

  async closeAll() {
    await Promise.allSettled(this.pool.map(s => s.browser.close()))
    this.pool = []
  }
}

const browserPool = new BrowserPool()
// 서버 종료 시 정리
process.on('SIGTERM', () => browserPool.closeAll())
process.on('SIGINT',  () => browserPool.closeAll())

// ─── 유틸 함수 ────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function normalizeUrl(url, base) {
  try {
    if (!url || url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('data:')) return null
    return new URL(url, base).href
  } catch {
    return null
  }
}

// ─── 한글 오탈자 검사 (Daum 맞춤법 검사기 기반) ────────
// Playwright로 dic.daum.net/grammar_checker.do 에 접근하여 검사
// errorType 코드: spell(철자), spacing(띄어쓰기), ambiguous(문맥), stat(통계)
const DAUM_ERROR_TYPE_LABEL = {
  spell:     '철자 오류',
  spacing:   '띄어쓰기',
  ambiguous: '문맥 오류',
  stat:      '통계적 교정',
  unknown:   '기타 오류',
}

// 텍스트에서 오탈자 위치(줄번호, 근사 컬럼)를 찾는 헬퍼
function findTokenPosition(fullText, token, context) {
  // context 기반으로 위치 탐색
  const ctxIdx = context ? fullText.indexOf(context.trim().substring(0, 30)) : -1
  const searchFrom = ctxIdx >= 0 ? ctxIdx : 0
  const idx = fullText.indexOf(token, searchFrom)
  if (idx === -1) return { line: null, col: null }
  const before = fullText.substring(0, idx)
  const lines = before.split('\n')
  return {
    line: lines.length,
    col: lines[lines.length - 1].length + 1
  }
}

// HTML 소스에서 노드 outerHTML의 줄번호를 근사 계산
function findHtmlLineNumber(nodeHtml, htmlLines) {
  if (!nodeHtml || !htmlLines) return null
  const snippet = nodeHtml.replace(/\s+/g, ' ').trim().substring(0, 160)
  const tagMatch = snippet.match(/^<(\w[\w-]*)/)
  if (!tagMatch) return null
  const tag = tagMatch[1].toLowerCase()
  // 고유 식별 속성 우선 탐색
  const idM    = snippet.match(/\bid=["']([^"']+)["']/)
  const srcM   = snippet.match(/\bsrc=["']([^"']{4,100})["']/)
  const hrefM  = snippet.match(/\bhref=["']([^"']{4,100})["']/)
  const forM   = snippet.match(/\bfor=["']([^"']+)["']/)
  const nameM  = snippet.match(/\bname=["']([^"']+)["']/)
  const ariaM  = snippet.match(/\baria-label=["']([^"']{3,60})["']/)
  const altM   = snippet.match(/\balt=["']([^"']{3,60})["']/)
  const roleM  = snippet.match(/\brole=["']([^"']+)["']/)
  const searches = []
  if (idM)   searches.push(`id="${idM[1]}"`, `id='${idM[1]}'`)
  if (srcM)  { const f = srcM[1].split('/').pop().substring(0,50); if (f.length>3) searches.push(f) }
  if (hrefM) { const f = hrefM[1].split('/').pop().substring(0,50); if (f.length>3) searches.push(f) }
  if (forM)  searches.push(`for="${forM[1]}"`, `for='${forM[1]}'`)
  if (nameM) searches.push(`name="${nameM[1]}"`)
  if (ariaM) searches.push(ariaM[1].substring(0,40))
  if (altM)  searches.push(altM[1].substring(0,40))
  if (roleM) searches.push(`role="${roleM[1]}"`)
  searches.push(`<${tag}`)          // 태그명 폴백
  for (const s of searches) {
    if (!s || s.length < 2) continue
    for (let li = 0; li < htmlLines.length; li++) {
      if (htmlLines[li].includes(s)) return li + 1
    }
  }
  return null
}

// Daum 맞춤법 검사기 호출 (별도 페이지 사용 - 원본 페이지 DOM 보존)
async function checkDaumSpelling(textChunks, pageUrl, browser) {
  // textChunks: 청크별 { text, lineOffset } 배열
  // browser: Playwright 브라우저 인스턴스 (별도 페이지 생성)
  const allIssues = []
  let daumPage = null

  try {
    // 별도 페이지 생성으로 원본 DOM 보존
    daumPage = await browser.newPage()
    await daumPage.setViewportSize({ width: 1280, height: 800 })

    // Daum 맞춤법 검사기 페이지 로드 (이미지/폰트 차단 → 빠른 로드)
    await daumPage.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,eot}', r => r.abort())
    await daumPage.goto('https://dic.daum.net/grammar_checker.do', {
      waitUntil: 'domcontentloaded', timeout: 20000
    })
    await daumPage.waitForSelector('#tfSpelling', { timeout: 10000 })
    await daumPage.waitForTimeout(100)

    for (const chunk of textChunks) {
      const { text, lineOffset = 0 } = chunk
      if (!text || text.trim().length < 2) continue

      try {
        // 텍스트 입력 (기존 내용 지우고 새 텍스트 입력)
        await daumPage.waitForSelector('#tfSpelling', { timeout: 8000 })
        await daumPage.fill('#tfSpelling', '')
        await daumPage.fill('#tfSpelling', text)

        // 검사 버튼 클릭
        await daumPage.waitForSelector('#btnCheck', { timeout: 8000 })
        await daumPage.click('#btnCheck')

        // 결과 대기: resultForm 또는 오류메시지 표시될 때까지
        try {
          await daumPage.waitForSelector('#resultForm', { timeout: 10000 })
        } catch {
          // resultForm도 없으면 스킵
          continue
        }
        await daumPage.waitForTimeout(100)

        // 오류 파싱
        const errors = await daumPage.evaluate(() => {
          const results = []
          document.querySelectorAll('a[data-error-type]').forEach(el => {
            results.push({
              token:      el.getAttribute('data-error-input')  || '',
              suggestion: el.getAttribute('data-error-output') || '',
              type:       el.getAttribute('data-error-type')   || 'unknown',
              context:    el.getAttribute('data-error-context')|| '',
              help:       el.getAttribute('data-error-help')   || '',
            })
          })
          return results
        })

        // 위치 정보 추가
        for (const err of errors) {
          if (!err.token) continue
          const pos = findTokenPosition(text, err.token, err.context)
          allIssues.push({
            word:       err.token,
            suggestion: err.suggestion,
            context:    err.context,
            desc:       DAUM_ERROR_TYPE_LABEL[err.type] || DAUM_ERROR_TYPE_LABEL.unknown,
            type:       err.type,
            help:       err.help,
            pageUrl:    pageUrl || '',
            line:       pos.line !== null ? pos.line + lineOffset : null,
            col:        pos.col,
            engine:     'daum',
          })
        }

      } catch (e) {
        console.error('[Daum 맞춤법] 청크 오류:', e.message)
      }
    }
  } catch (e) {
    console.error('[Daum 맞춤법] 페이지 초기화 오류:', e.message)
  } finally {
    if (daumPage) await daumPage.close().catch(() => {})
  }

  return allIssues
}

// 영문 오탈자 검사 제거 (한국어 전용)

// ─── 데드링크 검사 ────────────────────────────────────
async function checkDeadLinks(links, baseUrl, page) {
  // 동일 도메인 우선, 외부 링크는 최대 15개로 제한 (속도 최적화)
  const baseDomain = new URL(baseUrl).hostname
  const internalLinks = links.filter(l => { try { return new URL(l).hostname === baseDomain } catch { return false } }).slice(0, 30)
  const externalLinks = links.filter(l => { try { return new URL(l).hostname !== baseDomain } catch { return false } }).slice(0, 15)
  const allLinks = [...new Set([...internalLinks, ...externalLinks])].slice(0, 45)

  // 단일 링크 HEAD→GET 검사
  async function checkOne(link) {
    let status = null, ok = false, redirectUrl = null, error = null
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 4000)   // 7초→4초 단축
      const resp = await fetch(link, {
        method: 'HEAD', redirect: 'follow', signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (A11y-Inspector/1.0)' }
      })
      clearTimeout(timer)
      status = resp.status
      ok = resp.ok || [301,302,307,308].includes(resp.status)
      if (resp.url !== link) redirectUrl = resp.url
      if (resp.status === 405) {
        const ctrl2 = new AbortController()
        const timer2 = setTimeout(() => ctrl2.abort(), 4000)   // 7초→4초 단축
        const resp2 = await fetch(link, { method: 'GET', redirect: 'follow', signal: ctrl2.signal, headers: { 'User-Agent': 'Mozilla/5.0 (종합검사/2.0)' } })
        clearTimeout(timer2)
        status = resp2.status; ok = resp2.ok
      }
    } catch (e) {
      error = e.name === 'AbortError' ? '연결 시간 초과' : e.message.includes('fetch') ? '연결 실패' : e.message.substring(0, 60)
      ok = false
    }
    return { url: link, status, error, redirectUrl, ok }
  }

  // 병렬 처리 (최대 15개 동시, 10→15)
  const CONCUR = 15
  const results = []
  for (let i = 0; i < allLinks.length; i += CONCUR) {
    const batch = allLinks.slice(i, i + CONCUR)
    const settled = await Promise.allSettled(batch.map(checkOne))
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value)
      else results.push({ url: batch[results.length % CONCUR], status: null, error: s.reason?.message, ok: false })
    }
  }
  return { results, total: allLinks.length }
}

// ═══════════════════════════════════════════════════════
// ─── 로컬 HTML/JSP 파일 스캔 API ─────────────────────
// ═══════════════════════════════════════════════════════
// FormData: files[] + options(JSON string)
app.post('/api/scan/local', upload.array('files', 500), async (req, res) => {
  const files = req.files
  if (!files || files.length === 0) return res.status(400).json({ error: '파일이 없습니다.' })

  let options = {}
  try { options = JSON.parse(req.body.options || '{}') } catch(e) {}
  const {
    level = 'wcag2aa',
    includeScreenshot = false,   // 로컬 파일은 스크린샷 기본 비활성
    checkSpelling = false,
    checkLinks = false,
    checkW3C = false,
    checkKRDS = false,
  } = options

  // 임시 디렉토리에 파일 저장
  const tmpDir = join(tmpdir(), 'scan_local_' + randomBytes(6).toString('hex'))
  mkdirSync(tmpDir, { recursive: true })

  const tmpFiles = []
  for (const f of files) {
    const safeName = f.originalname.replace(/[^a-zA-Z0-9가-힣._-]/g, '_')
    const tmpPath = join(tmpDir, safeName)
    writeFileSync(tmpPath, f.buffer)
    tmpFiles.push({ path: tmpPath, name: f.originalname })
  }

  // 파일을 file:// URL로 변환하여 병렬 스캔 (최대 BATCH_CONCURRENCY 동시)
  const results = []
  const CONCUR = Math.min(BATCH_CONCURRENCY, 5)
  
  try {
    const queue = tmpFiles.map((f, i) => ({ ...f, idx: i }))
    const workers = Array.from({ length: CONCUR }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) break
        const fileUrl = `file://${item.path}`
        const result = await scanSinglePage(fileUrl, {
          level, includeScreenshot, checkSpelling, checkLinks,
          useW3CLinks: false, checkW3C, checkKRDS
        })
        result.fileName = item.name
        result.url = item.name   // 파일명을 URL 대신 표시
        results[item.idx] = result
      }
    })
    await Promise.allSettled(workers)
  } finally {
    // 임시 파일 정리
    for (const f of tmpFiles) { try { unlinkSync(f.path) } catch(e){} }
    try { require('fs').rmdirSync(tmpDir) } catch(e){}
  }

  res.json({ results: results.filter(Boolean), total: results.length })
})

// ═══════════════════════════════════════════════════════
// ─── 메인 통합 검사 API ───────────────────────────────
// ═══════════════════════════════════════════════════════
app.post('/api/scan', async (req, res) => {
  const {
    url,
    level = 'wcag2aa',
    includeScreenshot = true,
    checkSpelling = false,    // 기본: WCAG만 (옵션 선택 시 활성화)
    checkLinks = false,       // 기본: 비활성 (옵션 선택 시 활성화)
    useW3CLinks = false,    // W3C Link Checker 사용 여부
    checkW3C = false,
    checkKRDS: doCheckKRDS = false,  // KRDS 준수 검사 여부
  } = req.body

  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' })

  let normalizedUrl = url
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = 'https://' + normalizedUrl
  }

  let browser
  try {
    browser = await chromium.launch({
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-extensions', '--disable-default-apps', '--disable-sync', '--disable-translate',
        '--mute-audio', '--no-first-run', '--disable-background-networking',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-software-rasterizer', '--disable-ipc-flooding-protection',
        '--disable-hang-monitor', '--disable-domain-reliability',
        '--disable-component-update', '--disable-client-side-phishing-detection',
        '--js-flags=--max-old-space-size=128'
      ]
    })
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 900 })

    // 불필요 리소스 차단 → 로드 속도 대폭 향상
    if (!includeScreenshot) {
      await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,eot,mp4,mp3,pdf,flv,avi,mov,swf}', r => r.abort())
      await page.route('**/{gtag,analytics,ga,fbq,hotjar,clarity,matomo,pixel,beacon,telemetry}*', r => r.abort())
    } else {
      await page.route('**/*.{woff,woff2,ttf,eot,mp4,mp3,pdf,flv,avi,mov,swf}', r => r.abort())
    }
    // 광고/트래킹 도메인 차단 (공통)
    await page.route('**/{doubleclick,googlesyndication,adservice,adsystem,moatads,scorecardresearch,quantserve,chartbeat}**', r => r.abort())

    await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    // waitForTimeout 제거 → 즉시 처리 (domcontentloaded 후 충분)

    // 타이틀/URL 안전 취득 (리다이렉션·context 파괴 대응)
    let pageTitle = ''
    let pageUrl = normalizedUrl
    try {
      pageTitle = await page.title()
      pageUrl = page.url()
    } catch (e) {
      pageUrl = normalizedUrl
    }

    // ── 스크린샷 ──────────────────────────────────────
    let screenshotBase64 = null
    if (includeScreenshot) {
      const buf = await page.screenshot({ fullPage: false, type: 'png' })
      screenshotBase64 = buf.toString('base64')
    }

    // ── 접근성 검사 (axe-core) ────────────────────────
    // axeSource는 AXE_SOURCE 캐시 사용
    await page.addScriptTag({ content: AXE_SOURCE })
    const axeResults = await page.evaluate(async (runLevel) => {
      return await window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: runLevel === 'wcag2a' ? ['wcag2a'] :
                  runLevel === 'wcag2aa' ? ['wcag2a', 'wcag2aa'] :
                  ['wcag2a', 'wcag2aa', 'wcag2aaa']
        },
        resultTypes: ['violations', 'passes'],
        reporter: 'v1'
      })
    }, level)

    // ── HTML 소스 취득 (줄번호 계산 + W3C 검사 공유) ────
    const htmlSource = await page.content()
    const htmlLines  = htmlSource.split('\n')

    const violations = axeResults.violations.map(v => ({
      id: v.id, impact: v.impact, description: v.description,
      help: v.help, helpUrl: v.helpUrl, tags: v.tags,
      pageUrl,
      nodes: v.nodes.map(n => ({
        html: n.html,
        failureSummary: n.failureSummary,
        target: n.target,
        line: findHtmlLineNumber(n.html, htmlLines),
        pageUrl,
      }))
    }))
    const passes = axeResults.passes.length
    const incomplete = axeResults.incomplete.length
    const inapplicable = axeResults.inapplicable.length
    const impactCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 }
    violations.forEach(v => { if (v.impact) impactCounts[v.impact] = (impactCounts[v.impact] || 0) + 1 })
    const total = violations.length + passes
    const score = total === 0 ? 100 : Math.max(0, Math.round(100 - (
      (impactCounts.critical * 10 + impactCounts.serious * 5 + impactCounts.moderate * 2 + impactCounts.minor * 1) / Math.max(1, total) * 100
    )))

    // ── 오탈자 검사 (Daum 맞춤법 검사기) ─────────────────
    let spellingResult = { issues: [], totalWords: 0, checkedAt: new Date().toISOString() }
    if (checkSpelling) {
      // 페이지 텍스트 추출 (줄 단위 배열로) - body null 방지 처리 포함
      const pageLines = await page.evaluate(() => {
        if (!document.body) return []
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const tag = node.parentElement?.tagName?.toLowerCase()
            if (['script', 'style', 'noscript', 'code', 'pre'].includes(tag)) return NodeFilter.FILTER_REJECT
            return NodeFilter.FILTER_ACCEPT
          }
        })
        const texts = []
        let n
        while ((n = walker.nextNode())) {
          const t = n.textContent.trim()
          if (t.length > 1) texts.push(t)
        }
        return texts
      })

      const fullText = pageLines.join('\n')
      const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length

      // Daum 맞춤법 검사기용 청크 분할 (최대 1500자, 최대 5청크)
      const CHUNK_SIZE = 1500
      const MAX_CHUNKS = 5
      const chunks = []
      let lineOffset = 0
      let buf = []
      let bufLen = 0
      for (const line of pageLines) {
        if (bufLen + line.length + 1 > CHUNK_SIZE && buf.length > 0) {
          chunks.push({ text: buf.join('\n'), lineOffset })
          lineOffset += buf.length
          buf = []
          bufLen = 0
          if (chunks.length >= MAX_CHUNKS) break
        }
        buf.push(line)
        bufLen += line.length + 1
      }
      if (buf.length > 0 && chunks.length < MAX_CHUNKS) chunks.push({ text: buf.join('\n'), lineOffset })

      // Daum 맞춤법 검사 수행 (별도 페이지 생성 - 원본 DOM 보존)
      let koIssues = []
      try {
        koIssues = await checkDaumSpelling(chunks, pageUrl, browser)
      } catch (e) {
        console.error('[오탈자] Daum 검사 실패:', e.message)
      }

      spellingResult = {
        issues: koIssues.slice(0, 100),
        totalWords: wordCount,
        totalIssues: koIssues.length,
        koreanIssues: koIssues.length,
        engine: 'daum',
        checkedAt: new Date().toISOString()
      }
    }


    // ── 데드링크 검사 ─────────────────────────────────
    let linkResult = { dead: [], redirects: [], live: 0, total: 0, checkedAt: new Date().toISOString() }
    if (checkLinks) {
      if (useW3CLinks) {
        // ── W3C Link Checker 사용 ─────────────────────
        linkResult = await checkLinksWithW3C(pageUrl)
      } else {
        // ── 내장 HEAD/GET 검사 ─────────────────────────
        const rawLinks = await page.evaluate(() => {
          const links = []
          document.querySelectorAll('a[href], link[href]').forEach(el => {
            const href = el.getAttribute('href')
            const text = el.textContent?.trim().substring(0, 60) || el.tagName
            if (href) links.push({ href, text })
          })
          return links
        })

        const resolvedLinks = rawLinks
          .map(l => ({ ...l, resolved: normalizeUrl(l.href, pageUrl) }))
          .filter(l => l.resolved !== null)

        const uniqueUrls = [...new Set(resolvedLinks.map(l => l.resolved))]
        const linkTextMap = {}
        resolvedLinks.forEach(l => { if (!linkTextMap[l.resolved]) linkTextMap[l.resolved] = l.text })

        const { results, total } = await checkDeadLinks(uniqueUrls, pageUrl, page)

        const dead = results.filter(r => !r.ok).map(r => ({ ...r, text: linkTextMap[r.url] || '' }))
        const redirects = results.filter(r => r.ok && r.redirectUrl).map(r => ({ ...r, text: linkTextMap[r.url] || '' }))
        const live = results.filter(r => r.ok).length

        linkResult = {
          engine: 'internal',
          dead,
          redirects,
          live,
          total,
          totalRaw: rawLinks.length,
          checkedAt: new Date().toISOString()
        }
      }
    }

    // ── W3C Markup Validation ─────────────────────────
    let w3cResult = { valid: null, errorCount: 0, warningCount: 0, fatalCount: 0, errors: [], warnings: [] }
    if (checkW3C) {
      // htmlSource는 이미 위에서 취득
      w3cResult = await validateW3C(htmlSource, pageUrl)
    }

    // ── KRDS 준수 검사 ─────────────────────────────────
    let krdsResult = null
    if (doCheckKRDS) {
      try {
        krdsResult = await checkKRDS(page, htmlSource, pageUrl)
      } catch (e) {
        console.error('[KRDS] 검사 오류:', e.message)
        krdsResult = { error: e.message, score: 0, passed: 0, failed: 0, total: 0, items: [] }
      }
    }

    await browser.close()

    return res.json({
      id: Date.now().toString(),
      scannedAt: new Date().toISOString(),
      url: pageUrl,
      pageTitle,
      level,
      score,
      status: 'completed',
      summary: { violations: violations.length, passes, incomplete, inapplicable, impactCounts },
      violations,
      screenshot: screenshotBase64,
      spelling: spellingResult,
      links: linkResult,
      w3c: w3cResult,
      krds: krdsResult
    })

  } catch (err) {
    if (browser) await browser.close().catch(() => {})
    console.error('스캔 오류:', err.message)
    return res.status(500).json({ error: '스캔 중 오류가 발생했습니다: ' + err.message })
  }
})

// ═══════════════════════════════════════════════════════
// ─── HTML 보고서 생성 API ─────────────────────────────
// ═══════════════════════════════════════════════════════
app.post('/api/report', (req, res) => {
  const result = req.body
  if (!result || !result.url) return res.status(400).json({ error: '검사 결과가 필요합니다.' })
  
  // generateReportHtml 함수가 아직 정의되기 전이므로 여기서는 인라인으로 처리
  // (함수는 아래 민원 배치 섹션에 정의됨 - 순서 무관하게 호이스팅 없으므로 인라인 유지)

  const impactColor = { critical: '#dc2626', serious: '#ea580c', moderate: '#d97706', minor: '#65a30d' }
  const impactLabel = { critical: '치명적', serious: '심각', moderate: '보통', minor: '경미' }
  const scoreColor = result.score >= 80 ? '#22c55e' : result.score >= 50 ? '#f59e0b' : '#ef4444'

  // 접근성 위반 HTML
  const violationsHtml = result.violations.map((v, i) => `
    <div style="border-left:4px solid ${impactColor[v.impact]||'#6b7280'};margin-bottom:16px;padding:12px 16px;background:#fafafa;border-radius:0 8px 8px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong style="font-size:14px;color:#1e293b;">${i+1}. ${escapeHtml(v.help)}</strong>
        <span style="background:${impactColor[v.impact]||'#6b7280'};color:white;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;">${impactLabel[v.impact]||v.impact}</span>
      </div>
      <p style="color:#475569;font-size:12px;margin-bottom:6px;">${escapeHtml(v.description)}</p>
      <div style="font-size:11px;color:#64748b;margin-bottom:6px;"><strong>규칙:</strong> ${v.id} | <a href="${v.helpUrl}" style="color:#3b82f6;">가이드 →</a></div>
      <div style="background:#f1f5f9;border-radius:6px;padding:8px;font-size:11px;">
        ${v.nodes.slice(0,3).map(n=>`<div style="font-family:monospace;background:#e2e8f0;padding:3px 6px;border-radius:3px;margin-top:4px;word-break:break-all;">${escapeHtml(n.html)}</div><div style="color:#64748b;margin-top:2px;">${escapeHtml(n.failureSummary||'')}</div>`).join('')}
        ${v.nodes.length>3?`<div style="color:#94a3b8;margin-top:4px;">... 외 ${v.nodes.length-3}개</div>`:''}
      </div>
    </div>`).join('')

  // 오탈자 HTML
  const sp = result.spelling || {}
  const SPELL_TYPE_LABEL = { spell: '철자 오류', spacing: '띄어쓰기', ambiguous: '문맥 오류', stat: '통계 교정', korean: '한글', unknown: '기타' }
  const SPELL_TYPE_COLOR = { spell: '#dc2626', spacing: '#d97706', ambiguous: '#ea580c', stat: '#2563eb', korean: '#8b5cf6', unknown: '#6b7280' }
  const engineLabel = sp.engine === 'daum' ? '다음 맞춤법 검사기' : '규칙 기반'
  const spellingHtml = (sp.issues && sp.issues.length > 0) ? sp.issues.map((issue, i) => {
    const tc = SPELL_TYPE_COLOR[issue.type] || '#8b5cf6'
    const tl = SPELL_TYPE_LABEL[issue.type] || '기타'
    const lineInfo = issue.line ? `줄 ${issue.line}${issue.col ? ', 열 '+issue.col : ''}` : ''
    return `
    <div style="border-left:4px solid ${tc};margin-bottom:12px;padding:10px 14px;background:#fafafa;border-radius:0 6px 6px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="font-size:13px;color:#1e293b;">
          <strong style="color:#dc2626;">"${escapeHtml(issue.word)}"</strong>
          <span style="color:#94a3b8;margin:0 6px;">→</span>
          <strong style="color:#059669;">"${escapeHtml(issue.suggestion)}"</strong>
        </span>
        <span style="background:${tc};color:white;padding:1px 8px;border-radius:10px;font-size:10px;">${tl}</span>
      </div>
      ${issue.desc?`<div style="font-size:11px;color:#64748b;margin-bottom:4px;">${escapeHtml(issue.desc)}</div>`:''}
      ${issue.context?`<div style="font-family:monospace;font-size:11px;background:#e2e8f0;padding:3px 8px;border-radius:4px;color:#475569;margin-bottom:4px;">${escapeHtml(issue.context)}</div>`:''}
      <div style="font-size:11px;color:#94a3b8;display:flex;gap:12px;flex-wrap:wrap;">
        ${lineInfo ? `<span>📍 ${lineInfo}</span>` : ''}
        ${issue.pageUrl ? `<span>🔗 ${escapeHtml(issue.pageUrl)}</span>` : ''}
      </div>
    </div>`
  }).join('') : '<div style="text-align:center;padding:24px;color:#22c55e;font-weight:600;">✅ 오탈자가 감지되지 않았습니다.</div>'


  // 데드링크 HTML
  const lk = result.links || {}
  const deadLinksHtml = (lk.dead && lk.dead.length > 0) ? lk.dead.map((link, i) => `
    <div style="border-left:4px solid #ef4444;margin-bottom:12px;padding:10px 14px;background:#fef2f2;border-radius:0 6px 6px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <code style="font-size:11px;color:#1e293b;word-break:break-all;">${escapeHtml(link.url)}</code>
        <span style="background:#ef4444;color:white;padding:1px 8px;border-radius:10px;font-size:10px;white-space:nowrap;margin-left:8px;">${link.status||'오류'}</span>
      </div>
      ${link.text?`<div style="font-size:12px;color:#64748b;">링크 텍스트: "${escapeHtml(link.text)}"</div>`:''}
      ${link.error?`<div style="font-size:11px;color:#dc2626;margin-top:2px;">⚠ ${escapeHtml(link.error)}</div>`:''}
    </div>`).join('') : '<div style="text-align:center;padding:24px;color:#22c55e;font-weight:600;">✅ 데드링크가 발견되지 않았습니다.</div>'

  const redirectLinksHtml = (lk.redirects && lk.redirects.length > 0) ? lk.redirects.slice(0, 20).map(link => `
    <div style="border-left:4px solid #f59e0b;margin-bottom:8px;padding:8px 12px;background:#fffbeb;border-radius:0 6px 6px 0;font-size:11px;">
      <code style="word-break:break-all;color:#1e293b;">${escapeHtml(link.url)}</code>
      <div style="color:#92400e;margin-top:2px;">→ ${escapeHtml(link.redirectUrl||'')} (${link.status})</div>
    </div>`).join('') : ''

  // W3C 검사 결과 HTML
  const w3c = result.w3c || {}
  const w3cErrorsHtml = (w3c.errors && w3c.errors.length > 0)
    ? w3c.errors.slice(0, 30).map((e, i) => `
      <div style="border-left:4px solid #ef4444;margin-bottom:10px;padding:10px 14px;background:#fef2f2;border-radius:0 6px 6px 0;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;">
          <div style="font-size:12px;font-weight:600;color:#1e293b;flex:1;">${escapeHtml(e.message)}</div>
          <div style="display:flex;gap:4px;shrink:0;flex-shrink:0;">
            ${e.subType==='fatal'?'<span style="background:#dc2626;color:white;font-size:10px;padding:1px 6px;border-radius:4px;">치명적</span>':''}
            ${e.lastLine?`<span style="font-size:10px;color:#94a3b8;white-space:nowrap;">L${e.lastLine}${e.lastColumn?':C'+e.lastColumn:''}</span>`:''}
          </div>
        </div>
        ${e.extract?`<div style="font-family:monospace;font-size:11px;background:#fee2e2;padding:3px 8px;border-radius:4px;color:#7f1d1d;word-break:break-all;margin-top:4px;">${escapeHtml(e.extract)}</div>`:''}
      </div>`).join('')
    + (w3c.errors.length > 30 ? `<div style="text-align:center;color:#94a3b8;font-size:12px;padding:8px">… 외 ${w3c.errors.length-30}건</div>` : '')
    : '<div style="text-align:center;padding:20px;color:#22c55e;font-weight:600;">✅ W3C 오류가 없습니다.</div>'

  const w3cWarningsHtml = (w3c.warnings && w3c.warnings.length > 0)
    ? w3c.warnings.slice(0, 15).map((w, i) => `
      <div style="border-left:4px solid #f59e0b;margin-bottom:8px;padding:8px 12px;background:#fffbeb;border-radius:0 6px 6px 0;">
        <div style="font-size:12px;color:#1e293b;">${escapeHtml(w.message)}</div>
        ${w.extract?`<div style="font-family:monospace;font-size:11px;background:#fef3c7;padding:2px 6px;border-radius:3px;color:#78350f;margin-top:3px;word-break:break-all;">${escapeHtml(w.extract)}</div>`:''}
      </div>`).join('')
    : ''

  const screenshotSection = result.screenshot ? `
    <div class="section"><h2>📸 페이지 스크린샷</h2>
      <img src="data:image/png;base64,${result.screenshot}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,0.07);" />
    </div>` : ''

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>웹 품질 검사 보고서 - ${escapeHtml(result.pageTitle || result.url)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Apple SD Gothic Neo','Malgun Gothic',Arial,sans-serif;background:#f8fafc;color:#1e293b}
  .header{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:white;padding:36px 40px}
  .header h1{font-size:26px;font-weight:700;margin-bottom:6px}
  .meta{font-size:12px;opacity:.85;margin-top:3px}
  .container{max-width:960px;margin:0 auto;padding:28px 20px}
  .section{background:white;border-radius:12px;padding:24px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  .section h2{font-size:17px;font-weight:700;margin-bottom:16px;color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:8px}
  .score-num{font-size:68px;font-weight:800;color:${scoreColor};line-height:1}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  .stat{text-align:center;padding:14px;background:#f8fafc;border-radius:8px}
  .stat-num{font-size:28px;font-weight:700}
  .impact-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .impact-item{padding:12px;border-radius:8px;text-align:center}
  .impact-item .num{font-size:26px;font-weight:700;color:white}
  .impact-item .lbl{font-size:11px;color:rgba(255,255,255,.9);margin-top:2px}
  .summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
  .sum-box{padding:14px;border-radius:8px;text-align:center;border:1px solid}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600}
  .footer{text-align:center;color:#94a3b8;font-size:11px;margin-top:28px;padding-bottom:36px}
  @media print{body{background:white}.header{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="header">
  <div style="max-width:960px;margin:0 auto">
    <h1>🔍 웹 품질 종합 검사 보고서</h1>
    <div class="meta">🌐 URL: ${escapeHtml(result.url)}</div>
    <div class="meta">📄 제목: ${escapeHtml(result.pageTitle||'알 수 없음')}</div>
    <div class="meta">📅 검사 일시: ${new Date(result.scannedAt).toLocaleString('ko-KR')}</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <span class="badge" style="background:rgba(255,255,255,.2)">♿ 접근성 ${result.level.toUpperCase()}</span>
      <span class="badge" style="background:rgba(255,255,255,.2)">✍️ 오탈자 검사</span>
      <span class="badge" style="background:rgba(255,255,255,.2)">🔗 링크 검사</span>
      ${w3c.checkedAt ? '<span class="badge" style="background:rgba(255,255,255,.2)">🏷️ W3C 표준검사</span>' : ''}
    </div>
  </div>
</div>
<div class="container">

  <!-- 종합 현황 -->
  <div class="section">
    <h2>📊 종합 검사 현황</h2>
    <div class="summary-grid">
      <div class="sum-box" style="background:#fef2f2;border-color:#fecaca">
        <div style="font-size:11px;font-weight:600;color:#dc2626;margin-bottom:4px">♿ 접근성 위반</div>
        <div style="font-size:32px;font-weight:800;color:#dc2626">${result.summary.violations}</div>
        <div style="font-size:11px;color:#64748b">점수: ${result.score}/100</div>
      </div>
      <div class="sum-box" style="background:${sp.totalIssues>0?'#faf5ff':'#f0fdf4'};border-color:${sp.totalIssues>0?'#ddd6fe':'#bbf7d0'}">
        <div style="font-size:11px;font-weight:600;color:${sp.totalIssues>0?'#7c3aed':'#16a34a'};margin-bottom:4px">✍️ 오탈자</div>
        <div style="font-size:32px;font-weight:800;color:${sp.totalIssues>0?'#7c3aed':'#16a34a'}">${sp.totalIssues||0}</div>
        <div style="font-size:11px;color:#64748b">총 ${sp.totalWords||0}개 단어 검사</div>
      </div>
      <div class="sum-box" style="background:${lk.dead&&lk.dead.length>0?'#fef2f2':'#f0fdf4'};border-color:${lk.dead&&lk.dead.length>0?'#fecaca':'#bbf7d0'}">
        <div style="font-size:11px;font-weight:600;color:${lk.dead&&lk.dead.length>0?'#dc2626':'#16a34a'};margin-bottom:4px">🔗 데드링크</div>
        <div style="font-size:32px;font-weight:800;color:${lk.dead&&lk.dead.length>0?'#dc2626':'#16a34a'}">${lk.dead?lk.dead.length:0}</div>
        <div style="font-size:11px;color:#64748b">총 ${lk.total||0}개 링크 검사</div>
      </div>
    </div>
    ${w3c.checkedAt ? `
    <div style="margin-top:12px;padding:12px 16px;border-radius:8px;background:${(w3c.errorCount||0)>0?'#fef2f2':'#f0fdf4'};border:1px solid ${(w3c.errorCount||0)>0?'#fecaca':'#bbf7d0'}">
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        <div style="font-size:11px;font-weight:700;color:#1e293b;min-width:120px">🏷️ W3C 표준검사</div>
        <div style="text-align:center;min-width:70px">
          <div style="font-size:20px;font-weight:800;color:${(w3c.errorCount||0)>0?'#dc2626':'#16a34a'}">${w3c.errorCount||0}</div>
          <div style="font-size:10px;color:#64748b">오류</div>
        </div>
        <div style="text-align:center;min-width:70px">
          <div style="font-size:20px;font-weight:800;color:${(w3c.warningCount||0)>0?'#d97706':'#16a34a'}">${w3c.warningCount||0}</div>
          <div style="font-size:10px;color:#64748b">경고</div>
        </div>
        <div style="text-align:center;min-width:80px">
          <span style="font-size:13px;font-weight:700;padding:4px 12px;border-radius:20px;background:${w3c.valid===true?'#dcfce7':w3c.valid===false?'#fee2e2':'#f1f5f9'};color:${w3c.valid===true?'#16a34a':w3c.valid===false?'#dc2626':'#64748b'}">
            ${w3c.valid===true?'✅ 유효':w3c.valid===false?'❌ 무효':'⚪ 미검사'}
          </span>
        </div>
      </div>
    </div>` : ''}
  </div>

  <!-- 접근성 점수 -->
  <div class="section">
    <h2>♿ 접근성 검사 결과 (${result.level.toUpperCase()})</h2>
    <div style="display:grid;grid-template-columns:1fr 2fr;gap:20px;align-items:center;margin-bottom:20px">
      <div style="text-align:center">
        <div class="score-num">${result.score}</div>
        <div style="font-size:14px;color:#64748b">/ 100점</div>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-num" style="color:#ef4444">${result.summary.violations}</div><div style="font-size:11px;color:#64748b">위반</div></div>
        <div class="stat"><div class="stat-num" style="color:#22c55e">${result.summary.passes}</div><div style="font-size:11px;color:#64748b">통과</div></div>
        <div class="stat"><div class="stat-num" style="color:#f59e0b">${result.summary.incomplete}</div><div style="font-size:11px;color:#64748b">검토필요</div></div>
        <div class="stat"><div class="stat-num" style="color:#94a3b8">${result.summary.inapplicable}</div><div style="font-size:11px;color:#64748b">해당없음</div></div>
      </div>
    </div>
    <div class="impact-grid">
      <div class="impact-item" style="background:#dc2626"><div class="num">${result.summary.impactCounts.critical||0}</div><div class="lbl">치명적</div></div>
      <div class="impact-item" style="background:#ea580c"><div class="num">${result.summary.impactCounts.serious||0}</div><div class="lbl">심각</div></div>
      <div class="impact-item" style="background:#d97706"><div class="num">${result.summary.impactCounts.moderate||0}</div><div class="lbl">보통</div></div>
      <div class="impact-item" style="background:#65a30d"><div class="num">${result.summary.impactCounts.minor||0}</div><div class="lbl">경미</div></div>
    </div>
    ${result.violations.length > 0 ? `<div style="margin-top:20px">${violationsHtml}</div>` : '<div style="text-align:center;padding:32px;color:#22c55e;font-size:16px;font-weight:700">🎉 위반 항목 없음!</div>'}
  </div>

  ${screenshotSection}

  <!-- 오탈자 -->
  <div class="section">
    <h2>✍️ 오탈자 검사 결과</h2>
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="background:#f5f3ff;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#7c3aed">${sp.koreanIssues||0}</div>
        <div style="font-size:11px;color:#64748b">한글 오탈자</div>
      </div>
      <div style="background:#f8fafc;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#64748b">${sp.totalWords||0}</div>
        <div style="font-size:11px;color:#64748b">검사 어절 수</div>
      </div>
    </div>
    ${spellingHtml}
  </div>

  <!-- 데드링크 -->
  <div class="section">
    <h2>🔗 링크 검사 결과</h2>
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="background:#fef2f2;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#dc2626">${lk.dead?lk.dead.length:0}</div>
        <div style="font-size:11px;color:#64748b">데드링크</div>
      </div>
      <div style="background:#fffbeb;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#d97706">${lk.redirects?lk.redirects.length:0}</div>
        <div style="font-size:11px;color:#64748b">리다이렉트</div>
      </div>
      <div style="background:#f0fdf4;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#16a34a">${lk.live||0}</div>
        <div style="font-size:11px;color:#64748b">정상 링크</div>
      </div>
      <div style="background:#f8fafc;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#64748b">${lk.total||0}</div>
        <div style="font-size:11px;color:#64748b">검사 링크 수</div>
      </div>
    </div>
    ${lk.dead && lk.dead.length > 0 ? `<h3 style="font-size:13px;font-weight:700;color:#dc2626;margin-bottom:8px">❌ 오류 링크 (${lk.dead.length}개)</h3>${deadLinksHtml}` : deadLinksHtml}
    ${redirectLinksHtml ? `<h3 style="font-size:13px;font-weight:700;color:#d97706;margin-top:16px;margin-bottom:8px">↪ 리다이렉트 링크 (${lk.redirects?lk.redirects.length:0}개)</h3>${redirectLinksHtml}` : ''}
  </div>

  ${w3c.checkedAt ? `
  <!-- W3C 표준 검사 -->
  <div class="section">
    <h2>🏷️ W3C 표준 검사 결과 (Markup Validation)</h2>
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <div style="background:${(w3c.errorCount||0)>0?'#fef2f2':'#f0fdf4'};padding:10px 16px;border-radius:8px;text-align:center;min-width:80px">
        <div style="font-size:22px;font-weight:800;color:${(w3c.errorCount||0)>0?'#dc2626':'#16a34a'}">${w3c.errorCount||0}</div>
        <div style="font-size:11px;color:#64748b">오류</div>
      </div>
      <div style="background:${(w3c.warningCount||0)>0?'#fffbeb':'#f0fdf4'};padding:10px 16px;border-radius:8px;text-align:center;min-width:80px">
        <div style="font-size:22px;font-weight:800;color:${(w3c.warningCount||0)>0?'#d97706':'#16a34a'}">${w3c.warningCount||0}</div>
        <div style="font-size:11px;color:#64748b">경고</div>
      </div>
      ${(w3c.fatalCount||0)>0?`<div style="background:#fef2f2;padding:10px 16px;border-radius:8px;text-align:center;min-width:80px">
        <div style="font-size:22px;font-weight:800;color:#dc2626">${w3c.fatalCount}</div>
        <div style="font-size:11px;color:#64748b">치명적</div>
      </div>`:''}
      <div style="padding:10px 16px;border-radius:8px;text-align:center">
        <span style="font-size:14px;font-weight:700;padding:6px 16px;border-radius:20px;background:${w3c.valid===true?'#dcfce7':w3c.valid===false?'#fee2e2':'#f1f5f9'};color:${w3c.valid===true?'#16a34a':w3c.valid===false?'#dc2626':'#64748b'}">
          ${w3c.valid===true?'✅ 유효 (Valid)':w3c.valid===false?'❌ 무효 (Invalid)':'⚪ 미검사'}
        </span>
      </div>
    </div>
    ${w3cErrorsHtml}
    ${w3cWarningsHtml ? `<div style="margin-top:12px;margin-bottom:8px"><strong style="font-size:13px;color:#d97706">⚠️ 경고 목록 (${w3c.warnings.length}건)</strong></div>${w3cWarningsHtml}` : ''}
    <div style="font-size:10px;color:#94a3b8;margin-top:10px">검사 기준: W3C Markup Validation Service (validator.w3.org/nu) | 검사 일시: ${new Date(w3c.checkedAt).toLocaleString('ko-KR')}</div>
  </div>` : ''}

  <div class="footer">
    <p>본 보고서는 가디언즈 오브 겔럭시 자동 검사 결과입니다. (axe-core + Playwright)</p>
    <p>자동 검사는 전체 이슈의 일부만 탐지할 수 있으며, 전문가 수동 검토를 병행하시기 바랍니다.</p>
    <p style="margin-top:6px;color:#cbd5e1">생성: ${new Date().toLocaleString('ko-KR')}</p>
  </div>
</div>
</body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="a11y-report-${Date.now()}.html"`)
  res.send(html)
})

// ═══════════════════════════════════════════════════════
// ─── 민원안내 페이지 목록 조회 API ───────────────────
// ═══════════════════════════════════════════════════════

// 인메모리 저장소 (배치 스캔 세션 및 결과)
const batchSessions = new Map()
const evidenceStore = new Map()

// evidenceStore 크기 제한 헬퍼 (오래된 항목 자동 삭제로 메모리 과다 방지)
function addEvidence(id, data) {
  evidenceStore.set(id, data)
  if (evidenceStore.size > MAX_EVIDENCE_STORE) {
    // 가장 오래된 항목부터 삭제 (FIFO)
    const oldestKey = evidenceStore.keys().next().value
    evidenceStore.delete(oldestKey)
  }
}

// 배치 결과를 경량화하여 메모리 절약 (배치 테이블 표시용 summary만 유지)
function lightResult(result) {
  return {
    id: result.id,
    scannedAt: result.scannedAt,
    url: result.url,
    originalUrl: result.originalUrl,
    pageTitle: result.pageTitle,
    level: result.level,
    score: result.score,
    status: result.status,
    error: result.error,
    fileName: result.fileName,
    summary: result.summary,
    spelling: result.spelling ? {
      totalIssues: result.spelling.totalIssues ?? result.spelling.issues?.length ?? 0,
      totalWords: result.spelling.totalWords ?? 0
    } : null,
    links: result.links ? {
      dead: result.links.dead?.length ?? 0,
      redirects: result.links.redirects?.length ?? 0,
      live: result.links.live ?? 0,
      total: result.links.total ?? 0,
      engine: result.links.engine
    } : null,
    w3c: result.w3c ? {
      valid: result.w3c.valid,
      errorCount: result.w3c.errorCount ?? 0,
      warningCount: result.w3c.warningCount ?? 0
    } : null,
    krds: result.krds ? {
      score: result.krds.score ?? 0,
      passed: result.krds.passed ?? 0,
      total: result.krds.total ?? 0,
      failed: result.krds.failed ?? 0
    } : null
  }
}

// 민원 목록 조회 (plus.gov.kr API 활용 → www.gov.kr/mw 민원안내 URL 사용)
app.get('/api/minwon/list', async (req, res) => {
  const { page = 1, pageSize = 20, query = '' } = req.query
  const ps = Math.min(parseInt(pageSize) || 20, 1000)  // 최대 1000개 허용
  // GOV24_URL 기준으로 중복이 많으므로 실제 표시할 수보다 더 많이 가져옴
  // pageSize=1000일 때 충분히 수집하기 위해 최대 6000까지 허용
  const fetchSize = Math.min(ps * 6, 6000)
  const startCount = (parseInt(page) - 1) * ps

  try {
    const abortCtrl = new AbortController()
    const fetchTimer = setTimeout(() => abortCtrl.abort(), 10000)  // 10초 타임아웃
    const response = await fetch('https://plus.gov.kr/api/iwcas/guide/v1.0/search/mergeResult', {
      method: 'POST',
      signal: abortCtrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Referer': 'https://plus.gov.kr/minwon'
      },
      body: JSON.stringify({
        query: query || '',
        startCount: String(startCount),
        listCount: String(fetchSize),
        collections: 'IW_SERVICE',
        sortField: 'WEIGHT/DESC,RANK/DESC,INQ_CNT/DESC,TYPE_SN/ASC,UID/ASC',
        docId: ''
      })
    })
    clearTimeout(fetchTimer)

    const data = await response.json()
    const mergeResult = data.searchMergeResult?.MERGE_COLLECTION || []
    const totalCount = data.totalCount || data.searchMergeResult?.TOTAL_COUNT || 0

    // GOV24_URL 기준으로 www.gov.kr/mw URL 생성, 로그인 없이 접근 가능한 민원안내 페이지만 포함
    // GOV24_URL 예시: /mw/AA020InfoCappView.do?&CappBizCD=13100000026&tp_seq=01
    const seenUrls = new Set()
    const items = []
    for (const item of mergeResult) {
      if (!item.GOV24_URL) continue
      // CappBizCD 추출
      const bizCdMatch = item.GOV24_URL.match(/CappBizCD=(\w+)/)
      if (!bizCdMatch) continue
      const cappBizCd = bizCdMatch[1]
      // 로그인 필요 없는 민원안내 URL (AA020InfoCappView.do)
      const govUrl = `https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=${cappBizCd}`
      // CappBizCD 기준으로 중복 제거
      if (seenUrls.has(cappBizCd)) continue
      seenUrls.add(cappBizCd)
      items.push({
        id: cappBizCd,
        docId: item.DOCID,
        title: item.TITLE || '',
        content: item.CONTENT ? item.CONTENT.substring(0, 100) : '',
        category: item.L_CATEGORY ? item.L_CATEGORY.split('#')[1] || item.L_CATEGORY : '',
        subCategory: item.M_CATEGORY ? item.M_CATEGORY.split('#')[1] || item.M_CATEGORY : '',
        department: item.DEPARTMENT || '',
        url: govUrl,
        cappBizCd
      })
      if (items.length >= ps) break
    }

    res.json({
      total: totalCount,
      page: parseInt(page),
      pageSize: ps,
      items
    })
  } catch (err) {
    console.error('민원 목록 조회 오류:', err.message)
    res.status(500).json({ error: '민원 목록 조회 실패: ' + err.message })
  }
})

// ─── 민원 전체 URL 목록 수집 (배치 전체 검사용) ───────
// plus.gov.kr API를 페이지별로 순회하여 GOV24 URL 중복 제거 후 전부 수집
app.get('/api/minwon/all-urls', async (req, res) => {
  const { query = '' } = req.query
  try {
    const PAGE_BATCH = 200   // 1회 API 호출당 가져올 수
    let startCount = 0
    const seenCds = new Set()
    const allItems = []

    // 첫 번째 호출로 totalCount 파악
    const first = await fetchMinwonPage(query, 0, PAGE_BATCH)
    const total = first.total

    for (const item of first.items) {
      if (!seenCds.has(item.cappBizCd)) {
        seenCds.add(item.cappBizCd)
        allItems.push(item)
      }
    }
    startCount += PAGE_BATCH

    // 나머지 페이지 병렬 수집 (10개씩 묶어서)
    const remaining = Math.ceil((total - PAGE_BATCH) / PAGE_BATCH)
    const batches = []
    for (let i = 0; i < remaining; i++) {
      batches.push(startCount + i * PAGE_BATCH)
    }

    // 20개씩 병렬 처리
    const PARALLEL = 20
    for (let i = 0; i < batches.length; i += PARALLEL) {
      const chunk = batches.slice(i, i + PARALLEL)
      const results = await Promise.allSettled(
        chunk.map(sc => fetchMinwonPage(query, sc, PAGE_BATCH))
      )
      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const item of r.value.items) {
            if (!seenCds.has(item.cappBizCd)) {
              seenCds.add(item.cappBizCd)
              allItems.push(item)
            }
          }
        }
      }
    }

    res.json({ total: allItems.length, items: allItems })
  } catch (err) {
    console.error('전체 목록 수집 오류:', err.message)
    res.status(500).json({ error: '전체 목록 수집 실패: ' + err.message })
  }
})

// plus.gov.kr API 호출 헬퍼 (내부 함수)
async function fetchMinwonPage(query, startCount, listCount) {
  const response = await fetch('https://plus.gov.kr/api/iwcas/guide/v1.0/search/mergeResult', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Referer': 'https://plus.gov.kr/minwon'
    },
    body: JSON.stringify({
      query: query || '', startCount: String(startCount), listCount: String(listCount),
      collections: 'IW_SERVICE',
      sortField: 'WEIGHT/DESC,RANK/DESC,INQ_CNT/DESC,TYPE_SN/ASC,UID/ASC', docId: ''
    })
  })
  const data = await response.json()
  const mergeResult = data.searchMergeResult?.MERGE_COLLECTION || []
  const items = []
  for (const item of mergeResult) {
    if (!item.GOV24_URL) continue
    const bizCdMatch = item.GOV24_URL.match(/CappBizCD=(\w+)/)
    if (!bizCdMatch) continue
    const cappBizCd = bizCdMatch[1]
    items.push({
      id: cappBizCd, docId: item.DOCID, title: item.TITLE || '',
      content: item.CONTENT ? item.CONTENT.substring(0, 100) : '',
      category: item.L_CATEGORY ? item.L_CATEGORY.split('#')[1] || item.L_CATEGORY : '',
      subCategory: item.M_CATEGORY ? item.M_CATEGORY.split('#')[1] || item.M_CATEGORY : '',
      department: item.DEPARTMENT || '',
      url: `https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=${cappBizCd}`,
      cappBizCd
    })
  }
  return { total: data.totalCount || 0, items }
}

// ═══════════════════════════════════════════════════════
// ─── 엑셀 기반 차수별 민원 목록 API ──────────────────
// ═══════════════════════════════════════════════════════

// 엑셀에서 차수별 민원 항목 로드 (캐시)
let _minwonByStep = null
async function loadMinwonByStep() {
  if (_minwonByStep) return _minwonByStep
  const wb = new ExcelJS.Workbook()
  // 경로 후보: 환경변수 > __dirname 기준 > process.cwd() 기준 > 절대경로
  const candidates = [
    process.env.EXCEL_PATH,
    join(__dirname, 'data', 'minwon-list.xlsx'),
    join(process.cwd(), 'data', 'minwon-list.xlsx'),
    '/home/user/webapp/data/minwon-list.xlsx',
    '/app/data/minwon-list.xlsx'
  ].filter(Boolean)
  const excelPath = candidates.find(p => existsSync(p))
  if (!excelPath) {
    throw new Error(`민원 목록 엑셀 파일을 찾을 수 없습니다. 시도한 경로:\n${candidates.join('\n')}`)
  }
  console.log('[민원목록] 엑셀 로드:', excelPath)
  await wb.xlsx.readFile(excelPath)
  const ws = wb.getWorksheet(1)
  const byStep = { '1차': [], '2차': [], '3차': [] }
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const code = row.getCell(2).value
    const name = (row.getCell(3).value || '').toString().trim()
    const dept = (row.getCell(4).value || '').toString().trim()
    const step = (row.getCell(5).value || '').toString().trim()
    if (!code) continue
    const cappBizCd = String(code).trim()
    const url = `https://www.gov.kr/mw/AA020InfoCappView.do?CappBizCD=${cappBizCd}`
    const entry = { cappBizCd, title: name, department: dept, url, step }
    if (byStep[step]) byStep[step].push(entry)
  }
  _minwonByStep = byStep
  return byStep
}

// GET /api/debug/browser  → Playwright/Chromium 실행 테스트
app.get('/api/debug/browser', async (req, res) => {
  const result = { ok: false, error: null, chromiumPath: null, env: {} }
  try {
    result.env = {
      NODE_VERSION: process.version,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '(미설정)',
      HOME: process.env.HOME || '(미설정)',
      PATH_PREVIEW: (process.env.PATH || '').substring(0, 200)
    }
    // Chromium 경로 확인
    const { execSync } = await import('child_process')
    try {
      result.chromiumPath = execSync('which chromium-browser || which chromium || which google-chrome || echo "NOT_FOUND"', { timeout: 3000 }).toString().trim()
    } catch(e) { result.chromiumPath = 'command failed: ' + e.message }

    // 실제 Playwright launch 테스트
    const testBrowser = await chromium.launch({
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
      timeout: 15000
    })
    const page = await testBrowser.newPage()
    await page.goto('about:blank')
    const title = await page.title()
    await testBrowser.close()
    result.ok = true
    result.title = title
  } catch(e) {
    result.error = e.message
  }
  res.json(result)
})

// GET /api/minwon/steps  → 차수 목록 및 건수
app.get('/api/minwon/steps', async (req, res) => {
  try {
    const byStep = await loadMinwonByStep()
    res.json({
      steps: Object.keys(byStep).map(step => ({
        step,
        count: byStep[step].length
      }))
    })
  } catch (err) {
    console.error('차수 목록 오류:', err.message)
    res.status(500).json({ error: '차수 목록 조회 실패: ' + err.message })
  }
})

// GET /api/minwon/step/:step  → 해당 차수 민원 목록 (페이지네이션)
app.get('/api/minwon/step/:step', async (req, res) => {
  try {
    const { step } = req.params
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize) || 50), 1000)
    const byStep = await loadMinwonByStep()
    const list = byStep[step]
    if (!list) return res.status(400).json({ error: `알 수 없는 차수: ${step}` })
    const start = (page - 1) * pageSize
    const items = list.slice(start, start + pageSize)
    res.json({ step, total: list.length, page, pageSize, items })
  } catch (err) {
    console.error('차수별 목록 오류:', err.message)
    res.status(500).json({ error: '차수별 목록 조회 실패: ' + err.message })
  }
})

// POST /api/batch/start-step  → 특정 차수 전체 배치 검사 시작
app.post('/api/batch/start-step', async (req, res) => {
  const { step, options = {}, chunkSize = 1000 } = req.body
  if (!step) return res.status(400).json({ error: 'step 파라미터가 필요합니다.' })
  const safeChunk = Math.min(Math.max(parseInt(chunkSize) || 1000, 1), 1000)

  try {
    const byStep = await loadMinwonByStep()
    const allItems = byStep[step]
    if (!allItems || allItems.length === 0) {
      return res.status(404).json({ error: `${step} 차수에 해당하는 민원이 없습니다.` })
    }

    const sessionIds = []
    for (let i = 0; i < allItems.length; i += safeChunk) {
      const chunk = allItems.slice(i, i + safeChunk)
      const urls = chunk.map(item => ({
        url: item.url, title: item.title,
        category: item.step, department: item.department
      }))
      const sessionId = 'batch_' + step.replace('차', '') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2)
      const session = {
        id: sessionId,
        label: `${step} 차수 검사`,
        step,
        createdAt: new Date().toISOString(),
        total: urls.length,
        completed: 0,
        failed: 0,
        status: 'running',
        results: [],
        options,
        urls,
        chunkIndex: Math.floor(i / safeChunk),
        totalChunks: Math.ceil(allItems.length / safeChunk)
      }
      batchSessions.set(sessionId, session)
      sessionIds.push(sessionId)

      // 백그라운드 병렬 처리
      ;(async (sess, urlList) => {
        let jIdx = 0, done = 0
        const workers = Array.from({ length: BATCH_CONCURRENCY }, async () => {
          while (true) {
            const j = jIdx++
            if (j >= urlList.length) break
            const entry = urlList[j]
            const urlStr = typeof entry === 'string' ? entry : entry.url
            try {
              const result = await scanSinglePage(urlStr, options)
              if (typeof entry === 'object') {
                result.category = result.category || entry.category
                result.department = result.department || entry.department
              }
              addEvidence(result.id, result)
              const lightResult = {
                id: result.id, url: result.url, pageTitle: result.pageTitle,
                score: result.score, status: result.status,
                summary: result.summary, category: result.category,
                department: result.department, step: sess.step,
                spelling: result.spelling ? { totalIssues: result.spelling.totalIssues } : null,
                links: result.links ? { dead: Array.isArray(result.links.dead) ? result.links.dead.length : (result.links.dead || 0) } : null,
                w3c: result.w3c ? { errors: result.w3c.errors } : null,
                krds: result.krds ? { score: result.krds.score, failed: result.krds.failed } : null,
                scannedAt: result.scannedAt
              }
              sess.results.push(lightResult)
              if (result.status === 'error') sess.failed++
              else sess.completed++
            } catch (err) {
              sess.failed++
              sess.results.push({
                url: urlStr, status: 'error', error: err.message,
                id: Date.now().toString(36) + Math.random().toString(36).slice(2),
                score: 0, summary: { violations: 0, passes: 0, incomplete: 0, inapplicable: 0, impactCounts: {} }
              })
            }
            done++
            sess.progress = Math.round(done / urlList.length * 100)
          }
        })
        await Promise.allSettled(workers)
        sess.status = 'completed'
        sess.finishedAt = new Date().toISOString()
        console.log(`[배치완료] ${sess.label} sessionId=${sess.id} 완료=${sess.completed} 실패=${sess.failed}`)
      })(session, urls)
    }

    res.json({
      step,
      totalUrls: allItems.length,
      totalSessions: sessionIds.length,
      chunkSize: safeChunk,
      sessionIds,
      firstSessionId: sessionIds[0],
      message: `${step} 차수 ${allItems.length}개 URL을 ${sessionIds.length}개 세션으로 분할하여 검사를 시작합니다.`
    })
  } catch (err) {
    console.error('차수별 검사 시작 오류:', err.message)
    res.status(500).json({ error: '차수별 검사 시작 실패: ' + err.message })
  }
})

// ═══════════════════════════════════════════════════════
// ─── 배치 스캔 API ────────────────────────────────────
// ═══════════════════════════════════════════════════════

// ─── W3C Link Checker (validator.w3.org/checklink) ────
// 대상 URL을 W3C 공식 링크 검사기에 전달해 데드/리다이렉트 링크를 수집
async function checkLinksWithW3C(targetUrl) {
  const CHECK_URL = 'https://validator.w3.org/checklink'
  const params = new URLSearchParams({
    uri: targetUrl,
    hide_type: 'all',     // 리다이렉트 숨기기 (broken만 표시)
    depth: '0',           // 해당 페이지만 (recursive 없음)
    check: 'Check',
    _charset_: 'UTF-8',
    summary: 'on',
  })
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)   // 최대 60초
    const resp = await fetch(`${CHECK_URL}?${params.toString()}`, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (A11y-Inspector/1.0; +https://github.com/a11y-inspector)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    })
    clearTimeout(timer)
    const html = await resp.text()

    // HTML 파싱: <dt> 블록에서 링크 정보 추출
    const dead = []
    const redirects = []
    let total = 0

    // 전체 체크된 링크 수 파악
    const checkedMatch = html.match(/Checked\s+(\d+)\s+(?:link|document)/i)
    if (checkedMatch) total = parseInt(checkedMatch[1], 10)

    // broken/error 링크 추출
    // 패턴: <dt>...<span class='msg_loc'>Line: N</span>...<a href="URL">URL</a>...broken...</dt>
    //       <dd>...<strong>Status</strong>: CODE ...</dd>
    const dtBlocks = html.match(/<dt>[\s\S]*?<\/dd>/g) || []
    for (const block of dtBlocks) {
      const lineM   = block.match(/Line:\s*(\d+)/i)
      const urlM    = block.match(/<a href="(https?:\/\/[^"]+)"/)
      const statusM = block.match(/<strong>Status<\/strong>:\s*(\d+)/)
      const msgM    = block.match(/<dd[^>]*class=['"]message_explanation['"][^>]*>([\s\S]*?)<\/dd>/)
      const isBroken   = /broken|not found|cannot|refused|timed out|error/i.test(block)
      const isRedirect = /redirect/i.test(block)
      const redirectToM = block.match(/redirected[^<]*<a href="(https?:\/\/[^"]+)"/)

      const url    = urlM    ? urlM[1].split('"')[0]   : null
      const status = statusM ? parseInt(statusM[1], 10) : null
      const line   = lineM   ? parseInt(lineM[1], 10)   : null
      const msg    = msgM    ? msgM[1].replace(/<[^>]+>/g, '').trim().substring(0, 120) : null

      if (!url) continue

      if (isBroken) {
        dead.push({ url, status, line, error: msg || null, source: targetUrl })
      } else if (isRedirect) {
        redirects.push({
          url,
          status,
          line,
          redirectUrl: redirectToM ? redirectToM[1] : null,
          source: targetUrl
        })
      }
    }

    return {
      engine: 'w3c-checklink',
      checkedAt: new Date().toISOString(),
      dead,
      redirects,
      live: Math.max(0, total - dead.length - redirects.length),
      total,
      totalRaw: total,
      raw: html.length,   // 응답 크기 (디버깅용)
    }
  } catch (e) {
    console.error('[W3C LinkChecker] 오류:', e.message)
    return {
      engine: 'w3c-checklink',
      checkedAt: new Date().toISOString(),
      dead: [], redirects: [], live: 0, total: 0, totalRaw: 0,
      error: e.message
    }
  }
}

// ─── W3C Markup Validation (validator.w3.org/nu/) ──────
// HTML 소스를 받아 W3C nu API에 POST로 전송, JSON 결과 파싱
async function validateW3C(htmlSource, pageUrl) {
  const W3C_API = 'https://validator.w3.org/nu/'
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000) // 30초 타임아웃

    const res = await fetch(`${W3C_API}?out=json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'User-Agent': 'A11yInspector/1.0 (+https://github.com/loocrd-debug/a11y-inspector)'
      },
      body: htmlSource,
      signal: controller.signal
    })
    clearTimeout(timer)

    if (!res.ok) throw new Error(`W3C API HTTP ${res.status}`)
    const data = await res.json()

    const messages = data.messages || []

    // 타입별 분류
    const errors   = messages.filter(m => m.type === 'error')
    const warnings = messages.filter(m => m.type === 'info' && m.subType === 'warning')
    const infos    = messages.filter(m => m.type === 'info' && m.subType !== 'warning')

    // 오류 심각도별 분류
    const fatal    = errors.filter(m => m.subType === 'fatal')
    const nonFatal = errors.filter(m => m.subType !== 'fatal')

    return {
      valid: errors.length === 0,
      errorCount: errors.length,
      warningCount: warnings.length,
      fatalCount: fatal.length,
      errors: errors.map(m => ({
        type: m.type,
        subType: m.subType || '',
        message: m.message,
        extract: m.extract || '',
        lastLine: m.lastLine || null,
        lastColumn: m.lastColumn || null,
        firstLine: m.firstLine || null,
        firstColumn: m.firstColumn || null
      })),
      warnings: warnings.map(m => ({
        type: m.type,
        subType: m.subType || '',
        message: m.message,
        extract: m.extract || '',
        lastLine: m.lastLine || null,
        lastColumn: m.lastColumn || null
      })),
      checkedAt: new Date().toISOString(),
      url: pageUrl
    }
  } catch (err) {
    return {
      valid: null,
      errorCount: 0,
      warningCount: 0,
      fatalCount: 0,
      errors: [],
      warnings: [],
      checkedAt: new Date().toISOString(),
      url: pageUrl,
      error: err.message
    }
  }
}

// ─── KRDS (한국 디지털 서비스 표준) 준수 검사 ────────────
// 자동화 가능한 항목만 HTML DOM 분석으로 검사
async function checkKRDS(page, htmlSource, pageUrl) {
  const results = []

  // 헬퍼: 항목 추가
  function addItem(id, category, name, level, passed, detail, recommend = '') {
    results.push({ id, category, name, level, passed, detail, recommend })
  }

  // ── 페이지 기본 구조 DOM 검사 ──────────────────────────
  const domData = await page.evaluate(() => {
    const doc = document

    // 1. lang 속성
    const htmlEl = doc.documentElement
    const lang = htmlEl ? htmlEl.getAttribute('lang') || htmlEl.getAttribute('xml:lang') || '' : ''

    // 2. title
    const title = doc.title || ''

    // 3. charset
    const metaCharset = doc.querySelector('meta[charset]')?.getAttribute('charset') ||
                        doc.querySelector('meta[http-equiv="Content-Type"]')?.getAttribute('content') || ''

    // 4. viewport
    const viewport = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') || ''

    // 5. favicon
    const favicon = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')

    // 6. 건너뛰기 링크 (skip navigation)
    // href="#" 이거나 id/class에 skip이 포함되거나, 내용이 "본문 바로가기" 류
    const skipLinks = Array.from(doc.querySelectorAll('a[href]')).filter(el => {
      const href = el.getAttribute('href') || ''
      const text = el.textContent?.trim() || ''
      const cls  = el.className || ''
      const id   = el.id || ''
      return (
        href.startsWith('#') &&
        (
          /skip|jump|content|main|본문|바로가기|건너뛰기/i.test(text + cls + id)
        )
      )
    })

    // 7. 공식 배너 (대한민국 공식 전자정부 누리집 배너)
    // 텍스트 "이 누리집은 대한민국 공식 전자정부 누리집입니다" 또는 특정 배너 요소
    const allText = doc.body?.innerText || ''
    const hasOfficialBanner = /이\s*누리집은\s*대한민국\s*공식\s*전자정부/.test(allText) ||
      !!doc.querySelector('.official-banner, #official-banner, [class*="gov-banner"], [class*="official"]')

    // 8. 헤더 존재 여부
    const header = doc.querySelector('header, [role="banner"], #header, .header')

    // 9. 푸터 존재 여부
    const footer = doc.querySelector('footer, [role="contentinfo"], #footer, .footer')

    // 10. 메인 콘텐츠 영역
    const main = doc.querySelector('main, [role="main"], #content, #main, .main')

    // 11. 네비게이션 (GNB/LNB)
    const nav = doc.querySelector('nav, [role="navigation"]')

    // 12. h1 태그 (페이지 제목)
    const h1s = doc.querySelectorAll('h1')

    // 13. 이미지 alt 속성 누락 검사
    const imgs = Array.from(doc.querySelectorAll('img'))
    const missingAlt = imgs.filter(img => !img.hasAttribute('alt')).map(img => ({
      src: (img.getAttribute('src') || '').substring(0, 80),
      html: img.outerHTML.substring(0, 120)
    }))
    const emptyAlt  = imgs.filter(img => img.hasAttribute('alt') && img.getAttribute('alt').trim() === '' && !img.closest('[role="presentation"]'))
    // 장식 이미지(role="presentation" 또는 alt="") 제외한 의미있는 이미지
    const meaningfulImgs = imgs.filter(img => img.getAttribute('alt') && img.getAttribute('alt').trim() !== '')

    // 14. form 레이블 연결
    const inputs = Array.from(doc.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea'))
    const noLabel = inputs.filter(inp => {
      const id = inp.id
      if (id && doc.querySelector(`label[for="${id}"]`)) return false
      if (inp.getAttribute('aria-label')) return false
      if (inp.getAttribute('aria-labelledby')) return false
      if (inp.getAttribute('title')) return false
      if (inp.getAttribute('placeholder') && inp.tagName === 'INPUT') return false
      const wrappingLabel = inp.closest('label')
      if (wrappingLabel) return false
      return true
    }).map(inp => ({ html: inp.outerHTML.substring(0, 120) }))

    // 15. 새 창/탭 경고 (target="_blank")
    const newWindowLinks = Array.from(doc.querySelectorAll('a[target="_blank"]'))
    const missingNewWindowWarning = newWindowLinks.filter(el => {
      const text  = el.textContent?.trim() || ''
      const title = el.getAttribute('title') || ''
      const aria  = el.getAttribute('aria-label') || ''
      return !/새\s*창|new\s*window|새\s*탭|new\s*tab/i.test(text + title + aria)
    }).map(el => ({
      href: (el.getAttribute('href') || '').substring(0, 80),
      text: el.textContent?.trim().substring(0, 60) || ''
    }))

    // 16. 브레드크럼
    const breadcrumb = doc.querySelector('[aria-label*="breadcrumb"], [aria-label*="경로"], .breadcrumb, #breadcrumb, [class*="breadcrumb"], nav ol, nav ul')

    // 17. 개인정보처리방침 링크
    const privacyLink = Array.from(doc.querySelectorAll('a')).find(a => {
      const t = a.textContent?.trim() || ''
      const h = a.getAttribute('href') || ''
      return /개인정보|privacy/i.test(t + h)
    })

    // 18. 저작권 표시
    const copyrightText = /copyright|©|저작권/i.test(allText)

    // 19. 검색 기능
    const searchForm = doc.querySelector('[role="search"], form[action*="search"], input[type="search"], input[name*="search"], input[name*="query"], input[name*="keyword"]')

    // 20. 오류 페이지 감지 여부 (타이틀이나 본문에 404/오류 메시지)
    const isErrorPage = /404|not\s*found|페이지를\s*찾을\s*수\s*없/i.test(title + allText.substring(0, 500))

    // 21. 로고 alt 텍스트
    const logoImgs = Array.from(doc.querySelectorAll('[class*="logo"] img, #logo img, header img, .header img'))
    const logoMissingAlt = logoImgs.filter(img => !img.getAttribute('alt') || img.getAttribute('alt').trim() === '')

    // 22. 반응형 메타 viewport
    const hasResponsiveViewport = /width=device-width/i.test(viewport)

    // 23. 링크 텍스트 의미성 ("여기", "클릭", "more", "바로가기" 등 비의미적 링크)
    const allLinks = Array.from(doc.querySelectorAll('a[href]'))
    const meaninglessLinks = allLinks.filter(a => {
      const t = a.textContent?.trim() || ''
      const aria = a.getAttribute('aria-label') || ''
      if (aria) return false
      return /^(여기|클릭|click\s*here|more|바로가기|자세히|see\s*more|read\s*more)$/i.test(t)
    }).map(a => ({
      text: a.textContent?.trim().substring(0, 60) || '',
      href: (a.getAttribute('href') || '').substring(0, 80)
    }))

    // 24. 테이블 헤더 th 존재
    const tables = Array.from(doc.querySelectorAll('table'))
    const tablesWithoutHeader = tables.filter(t => !t.querySelector('th')).length
    const tablesTotal = tables.length

    // 25. iframe title
    const iframes = Array.from(doc.querySelectorAll('iframe'))
    const iframesMissingTitle = iframes.filter(f => !f.getAttribute('title') && !f.getAttribute('aria-label')).map(f => ({
      src: (f.getAttribute('src') || '').substring(0, 80)
    }))

    return {
      lang, title, metaCharset, viewport, hasResponsiveViewport,
      hasFavicon: !!favicon,
      skipLinksCount: skipLinks.length,
      hasOfficialBanner,
      hasHeader: !!header,
      hasFooter: !!footer,
      hasMain: !!main,
      hasNav: !!nav,
      h1Count: h1s.length,
      imgsTotal: imgs.length,
      missingAlt, emptyAltCount: emptyAlt.length,
      noLabel,
      missingNewWindowWarning: missingNewWindowWarning.slice(0, 10),
      hasBreadcrumb: !!breadcrumb,
      hasPrivacyLink: !!privacyLink,
      hasCopyright: copyrightText,
      hasSearch: !!searchForm,
      isErrorPage,
      logoMissingAlt: logoMissingAlt.length,
      meaninglessLinks: meaninglessLinks.slice(0, 10),
      tablesWithoutHeader, tablesTotal,
      iframesMissingTitle: iframesMissingTitle.slice(0, 5),
    }
  })

  // ── 항목별 판정 ────────────────────────────────────────

  // [필수] 1. lang 속성
  addItem('lang', '기본 구조', 'HTML lang 속성', '필수',
    domData.lang && /^ko|en|ja|zh/.test(domData.lang),
    domData.lang ? `lang="${domData.lang}"` : 'lang 속성 없음',
    'html 태그에 lang="ko" 추가 필요'
  )

  // [필수] 2. 페이지 타이틀
  addItem('title', '기본 구조', '페이지 title 태그', '필수',
    domData.title && domData.title.trim().length > 0,
    domData.title ? `"${domData.title.substring(0, 60)}"` : 'title 없음',
    '각 페이지를 구분할 수 있는 의미있는 title 설정 필요'
  )

  // [필수] 3. 문자셋
  addItem('charset', '기본 구조', '문자셋(charset) 선언', '필수',
    /utf-?8/i.test(domData.metaCharset),
    domData.metaCharset || '선언 없음',
    'meta charset="UTF-8" 선언 필요'
  )

  // [필수] 4. viewport
  addItem('viewport', '기본 구조', 'viewport 메타 태그', '필수',
    !!domData.viewport,
    domData.viewport || '없음',
    'meta name="viewport" content="width=device-width, initial-scale=1.0" 추가 필요'
  )

  // [권장] 5. 반응형 viewport (width=device-width)
  addItem('responsive-viewport', '기본 구조', '반응형 viewport 설정', '권장',
    domData.hasResponsiveViewport,
    domData.hasResponsiveViewport ? 'width=device-width 포함' : 'width=device-width 미설정',
    'viewport에 width=device-width 포함 권장'
  )

  // [권장] 6. favicon
  addItem('favicon', '아이덴티티', '파비콘(favicon)', '권장',
    domData.hasFavicon,
    domData.hasFavicon ? '파비콘 있음' : '파비콘 없음',
    'link rel="icon" 으로 파비콘 설정 권장'
  )

  // [필수] 7. 건너뛰기 링크
  addItem('skip-nav', '접근성·탐색', '건너뛰기 링크', '필수',
    domData.skipLinksCount > 0,
    domData.skipLinksCount > 0 ? `${domData.skipLinksCount}개 발견` : '건너뛰기 링크 없음',
    '페이지 최상단에 "본문 바로가기" 등의 건너뛰기 링크 추가 필요 (WCAG 2.4.1)'
  )

  // [필수] 8. 공식 배너
  addItem('official-banner', '아이덴티티', '대한민국 공식 전자정부 배너', '필수',
    domData.hasOfficialBanner,
    domData.hasOfficialBanner ? '공식 배너 있음' : '공식 배너 없음',
    '"이 누리집은 대한민국 공식 전자정부 누리집입니다" 배너 추가 필요'
  )

  // [필수] 9. 헤더
  addItem('header', '레이아웃·구조', '헤더(header) 영역', '필수',
    domData.hasHeader,
    domData.hasHeader ? 'header 요소 있음' : 'header 요소 없음',
    'header 태그 또는 role="banner" 속성 추가 필요'
  )

  // [필수] 10. 푸터
  addItem('footer', '레이아웃·구조', '푸터(footer) 영역', '필수',
    domData.hasFooter,
    domData.hasFooter ? 'footer 요소 있음' : 'footer 요소 없음',
    'footer 태그 또는 role="contentinfo" 속성 추가 필요'
  )

  // [권장] 11. 메인 콘텐츠 영역
  addItem('main', '레이아웃·구조', '메인 콘텐츠 영역(main)', '권장',
    domData.hasMain,
    domData.hasMain ? 'main 요소 있음' : 'main 요소 없음',
    'main 태그 또는 role="main" 속성 추가 권장'
  )

  // [권장] 12. 네비게이션
  addItem('nav', '탐색', '내비게이션(nav) 요소', '권장',
    domData.hasNav,
    domData.hasNav ? 'nav 요소 있음' : 'nav 요소 없음',
    'nav 태그 또는 role="navigation" 속성 추가 권장'
  )

  // [필수] 13. h1 태그
  const h1Pass = domData.h1Count === 1
  addItem('h1', '콘텐츠 구조', 'H1 제목 태그 (1개)', '필수',
    h1Pass,
    domData.h1Count === 0 ? 'h1 없음' : domData.h1Count === 1 ? 'h1 1개 (정상)' : `h1 ${domData.h1Count}개 (중복)`,
    'h1 태그는 페이지당 정확히 1개여야 함'
  )

  // [필수] 14. 이미지 alt 누락
  const altPass = domData.missingAlt.length === 0
  addItem('img-alt', '접근성·콘텐츠', '이미지 alt 속성', '필수',
    altPass,
    altPass ? `전체 이미지 ${domData.imgsTotal}개 중 alt 누락 없음` :
      `alt 누락 ${domData.missingAlt.length}개/${domData.imgsTotal}개 (예: ${domData.missingAlt[0]?.src || ''})`,
    '모든 의미있는 이미지에 alt 속성 추가 필요 (WCAG 1.1.1)'
  )

  // [필수] 15. 폼 레이블
  const labelPass = domData.noLabel.length === 0
  addItem('form-label', '접근성·입력', '폼 요소 레이블 연결', '필수',
    labelPass,
    labelPass ? '모든 폼 요소에 레이블 연결됨' :
      `레이블 없는 폼 ${domData.noLabel.length}개 (예: ${domData.noLabel[0]?.html || ''})`,
    'input, select, textarea에 label[for] 또는 aria-label 연결 필요 (WCAG 1.3.1)'
  )

  // [권장] 16. 새 창 경고
  const newWinPass = domData.missingNewWindowWarning.length === 0
  addItem('new-window', '접근성·탐색', '새 창 열림 안내', '권장',
    newWinPass,
    newWinPass ? '새 창 링크 모두 안내 있음' :
      `안내 없는 새 창 링크 ${domData.missingNewWindowWarning.length}개 (예: "${domData.missingNewWindowWarning[0]?.text || ''}")`,
    'target="_blank" 링크에 title 또는 텍스트로 "새 창" 안내 필요'
  )

  // [권장] 17. 브레드크럼
  addItem('breadcrumb', '탐색', '브레드크럼(현재위치) 표시', '권장',
    domData.hasBreadcrumb,
    domData.hasBreadcrumb ? '브레드크럼 있음' : '브레드크럼 없음',
    '현재 페이지 위치를 나타내는 브레드크럼 제공 권장'
  )

  // [필수] 18. 개인정보처리방침 링크
  addItem('privacy', '법적 준수', '개인정보처리방침 링크', '필수',
    domData.hasPrivacyLink,
    domData.hasPrivacyLink ? '개인정보처리방침 링크 있음' : '개인정보처리방침 링크 없음',
    '개인정보처리방침 페이지 링크 제공 필요 (전자정부법)'
  )

  // [권장] 19. 저작권 표시
  addItem('copyright', '법적 준수', '저작권(copyright) 표시', '권장',
    domData.hasCopyright,
    domData.hasCopyright ? '저작권 표시 있음' : '저작권 표시 없음',
    '푸터 등에 저작권 표시 권장'
  )

  // [권장] 20. 검색 기능
  addItem('search', '탐색', '검색 기능', '권장',
    domData.hasSearch,
    domData.hasSearch ? '검색 기능 있음' : '검색 기능 없음',
    '사용자가 원하는 정보를 찾을 수 있도록 검색 기능 제공 권장'
  )

  // [권장] 21. 로고 alt
  if (domData.logoMissingAlt > 0 || domData.imgsTotal > 0) {
    addItem('logo-alt', '아이덴티티', '로고 이미지 alt 텍스트', '권장',
      domData.logoMissingAlt === 0,
      domData.logoMissingAlt > 0 ? `로고 이미지 alt 없음 ${domData.logoMissingAlt}개` : '로고 alt 적절히 설정됨',
      '헤더 로고 이미지에 기관명 alt 텍스트 설정 권장'
    )
  }

  // [권장] 22. 의미없는 링크 텍스트
  if (domData.meaninglessLinks.length > 0) {
    addItem('link-text', '접근성·탐색', '링크 텍스트 의미성', '권장',
      false,
      `비의미적 링크 ${domData.meaninglessLinks.length}개 (예: "${domData.meaninglessLinks[0]?.text}")`,
      '"여기", "바로가기" 등 비의미적 링크 텍스트는 구체적인 텍스트나 aria-label로 개선 권장'
    )
  } else {
    addItem('link-text', '접근성·탐색', '링크 텍스트 의미성', '권장',
      true,
      '비의미적 링크 없음',
      ''
    )
  }

  // [권장] 23. 테이블 헤더
  if (domData.tablesTotal > 0) {
    addItem('table-header', '접근성·콘텐츠', '표(table) 헤더 th 사용', '권장',
      domData.tablesWithoutHeader === 0,
      domData.tablesWithoutHeader > 0
        ? `th 없는 table ${domData.tablesWithoutHeader}개/${domData.tablesTotal}개`
        : `전체 table ${domData.tablesTotal}개 모두 th 있음`,
      '데이터 테이블에 th 요소로 헤더 구분 필요'
    )
  }

  // [권장] 24. iframe title
  if (domData.iframesMissingTitle.length > 0) {
    addItem('iframe-title', '접근성', 'iframe title 속성', '권장',
      false,
      `title 없는 iframe ${domData.iframesMissingTitle.length}개`,
      'iframe에 title 속성으로 목적 설명 필요 (WCAG 4.1.2)'
    )
  }

  // ── 결과 집계 ──────────────────────────────────────────
  const passed    = results.filter(r => r.passed === true).length
  const failed    = results.filter(r => r.passed === false).length
  const total     = results.length
  const score     = total > 0 ? Math.round((passed / total) * 100) : 0
  const mandatory = results.filter(r => r.level === '필수')
  const mandatoryPassed = mandatory.filter(r => r.passed).length
  const recommended = results.filter(r => r.level === '권장')
  const recommendedPassed = recommended.filter(r => r.passed).length

  return {
    checkedAt: new Date().toISOString(),
    url: pageUrl,
    score,
    passed, failed, total,
    mandatory: { total: mandatory.length, passed: mandatoryPassed },
    recommended: { total: recommended.length, passed: recommendedPassed },
    items: results
  }
}

// 단일 페이지 스캔 (배치용 내부 함수)
async function scanSinglePage(url, options = {}) {
  const {
    level = 'wcag2aa',
    includeScreenshot = true,
    checkSpelling = true,
    checkLinks = false,
    useW3CLinks = false,      // W3C Link Checker 사용 여부
    checkW3C = false,
    containerOnly = false,    // true: <!-- cont-inner info-detail// --> 영역만 검사
    checkKRDS: doCheckKRDS = false,  // KRDS 준수 검사 여부
  } = options
  
  let poolSlot = null
  let page = null
  try {
    // 브라우저 풀에서 인스턴스 획득
    poolSlot = await browserPool.acquire()
    const browser = poolSlot.browser
    page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 900 })

    // 이미지·폰트·미디어 차단 → 로드 속도 향상 (스크린샷 필요 시 이미지는 허용)
    // file:// 로컬파일은 광고/트래킹 차단 불필요, 나머지만 차단
    const isLocal = url.startsWith('file://')
    if (!includeScreenshot) {
      await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,eot,mp4,mp3,pdf,flv,avi,mov,swf}', r => r.abort())
      if (!isLocal) await page.route('**/{gtag,analytics,ga,fbq,hotjar,clarity,matomo,pixel,beacon,telemetry}*', r => r.abort())
    } else {
      await page.route('**/*.{woff,woff2,ttf,eot,mp4,mp3,pdf,flv,avi,mov,swf}', r => r.abort())
    }
    if (!isLocal) {
      // 광고/트래킹 도메인 차단 (공통, 외부 URL만)
      await page.route('**/{doubleclick,googlesyndication,adservice,adsystem,moatads,scorecardresearch,quantserve,chartbeat,adnxs}**', r => r.abort())
    }

    const gotoTimeout = isLocal ? 10000 : 20000
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoTimeout })

    // 페이지 타이틀 안전하게 취득 (리다이렉션 후에도 유효)
    let pageTitle = ''
    let pageUrl = url
    try {
      pageTitle = await page.title()
      pageUrl = page.url()
    } catch (e) {
      // 리다이렉션으로 context 파괴된 경우 URL만 유지
      pageUrl = url
    }

    // 스크린샷
    let screenshotBase64 = null
    if (includeScreenshot) {
      const buf = await page.screenshot({ fullPage: false, type: 'png' })
      screenshotBase64 = buf.toString('base64')
    }

    // 접근성 검사
    // axeSource는 AXE_SOURCE 캐시 사용
    await page.addScriptTag({ content: AXE_SOURCE })
    const axeResults = await page.evaluate(async (runLevel) => {
      return await window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: runLevel === 'wcag2a' ? ['wcag2a'] :
                  runLevel === 'wcag2aa' ? ['wcag2a', 'wcag2aa'] :
                  ['wcag2a', 'wcag2aa', 'wcag2aaa']
        },
        // 성능 최적화: 불필요한 데이터 최소화
        resultTypes: ['violations', 'passes'],
        reporter: 'v1'
      })
    }, level)

    // ── HTML 소스 취득 (줄번호 계산 + W3C 검사 공유) ────
    const htmlSource = await page.content()
    const htmlLines  = htmlSource.split('\n')

    const violations = axeResults.violations.map(v => ({
      id: v.id, impact: v.impact, description: v.description,
      help: v.help, helpUrl: v.helpUrl, tags: v.tags,
      pageUrl,
      nodes: v.nodes.map(n => ({
        html: n.html,
        failureSummary: n.failureSummary,
        target: n.target,
        line: findHtmlLineNumber(n.html, htmlLines),
        pageUrl,
      }))
    }))
    const passes = axeResults.passes.length
    const incomplete = axeResults.incomplete.length
    const inapplicable = axeResults.inapplicable.length
    const impactCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 }
    violations.forEach(v => { if (v.impact) impactCounts[v.impact] = (impactCounts[v.impact] || 0) + 1 })
    const total = violations.length + passes
    const score = total === 0 ? 100 : Math.max(0, Math.round(100 - (
      (impactCounts.critical * 10 + impactCounts.serious * 5 + impactCounts.moderate * 2 + impactCounts.minor * 1) / Math.max(1, total) * 100
    )))

    // 오탈자 검사 (Daum 맞춤법 검사기)
    // containerOnly=true 이면 <!-- cont-inner info-detail// --> 주석 사이 HTML만 검사
    let spellingResult = { issues: [], totalWords: 0, checkedAt: new Date().toISOString() }
    if (checkSpelling) {
      let pageLines
      if (containerOnly) {
        // HTML 소스에서 컨테이너 영역 추출 후 텍스트 파싱
        pageLines = await page.evaluate((src) => {
          // <!-- cont-inner info-detail// --> 주석 사이 내용 추출
          const m = src.match(/<!--\s*cont-inner\s+info-detail[^>]*?-->([\s\S]*?)<!--\s*cont-inner\s+info-detail[^>]*?\/\/\s*-->/)
          const region = m ? m[1] : src
          // 임시 div에 파싱해 텍스트 추출
          const div = document.createElement('div')
          div.innerHTML = region
          const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              const tag = node.parentElement?.tagName?.toLowerCase()
              if (['script','style','noscript','code','pre'].includes(tag)) return NodeFilter.FILTER_REJECT
              return NodeFilter.FILTER_ACCEPT
            }
          })
          const texts = []
          let n
          while ((n = walker.nextNode())) {
            const t = n.textContent.trim()
            if (t.length > 1) texts.push(t)
          }
          return texts
        }, htmlSource)
      } else {
        pageLines = await page.evaluate(() => {
          if (!document.body) return []
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
              const tag = node.parentElement?.tagName?.toLowerCase()
              if (['script', 'style', 'noscript', 'code', 'pre'].includes(tag)) return NodeFilter.FILTER_REJECT
              return NodeFilter.FILTER_ACCEPT
            }
          })
          const texts = []
          let n
          while ((n = walker.nextNode())) {
            const t = n.textContent.trim()
            if (t.length > 1) texts.push(t)
          }
          return texts
        })
      }

      const fullText = pageLines.join('\n')
      const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length

      const CHUNK_SIZE = 1500
      const MAX_CHUNKS = containerOnly ? 2 : 5   // 컨테이너만 모드는 청크 더 적게
      const chunks = []
      let lineOffset = 0
      let buf = []
      let bufLen = 0
      for (const line of pageLines) {
        if (bufLen + line.length + 1 > CHUNK_SIZE && buf.length > 0) {
          chunks.push({ text: buf.join('\n'), lineOffset })
          lineOffset += buf.length
          buf = []
          bufLen = 0
          if (chunks.length >= MAX_CHUNKS) break
        }
        buf.push(line)
        bufLen += line.length + 1
      }
      if (buf.length > 0 && chunks.length < MAX_CHUNKS) chunks.push({ text: buf.join('\n'), lineOffset })

      let koIssues = []
      try {
        koIssues = await checkDaumSpelling(chunks, pageUrl, browser)
      } catch (e) {
        console.error('[오탈자] Daum 검사 실패:', e.message)
      }
      spellingResult = {
        issues: koIssues.slice(0, 100),
        totalWords: wordCount,
        totalIssues: koIssues.length,
        koreanIssues: koIssues.length,
        engine: 'daum',
        containerOnly,
        checkedAt: new Date().toISOString()
      }
    }


    // 데드링크 검사
    let linkResult = { dead: [], redirects: [], live: 0, total: 0, checkedAt: new Date().toISOString() }
    if (checkLinks) {
      if (useW3CLinks) {
        // ── W3C Link Checker 사용 ─────────────────────
        // containerOnly=true 이면 컨테이너 영역의 링크만 추출하여 개별 검사
        if (containerOnly) {
          const containerLinks = await page.evaluate((src) => {
            const m = src.match(/<!--\s*cont-inner\s+info-detail[^>]*?-->([\s\S]*?)<!--\s*cont-inner\s+info-detail[^>]*?\/\/\s*-->/)
            const region = m ? m[1] : ''
            if (!region) return []
            const div = document.createElement('div')
            div.innerHTML = region
            const links = []
            div.querySelectorAll('a[href]').forEach(el => {
              const href = el.getAttribute('href')
              const text = el.textContent?.trim().substring(0, 60) || ''
              if (href && /^https?:/.test(href)) links.push({ href, text })
            })
            return links
          }, htmlSource)
          const w3cFull = await checkLinksWithW3C(pageUrl)
          const containerHrefs = new Set(containerLinks.map(l => l.href))
          const filterByContainer = (arr) => containerHrefs.size
            ? arr.filter(item => containerHrefs.has(item.url))
            : arr
          linkResult = {
            ...w3cFull,
            dead: filterByContainer(w3cFull.dead),
            redirects: filterByContainer(w3cFull.redirects),
            containerOnly: true
          }
        } else {
          linkResult = await checkLinksWithW3C(pageUrl)
        }
      } else {
        // ── 내장 HEAD/GET 검사 ─────────────────────────
        // containerOnly=true 이면 컨테이너 영역의 링크만 수집
        let rawLinks
        if (containerOnly) {
          rawLinks = await page.evaluate((src) => {
            const m = src.match(/<!--\s*cont-inner\s+info-detail[^>]*?-->([\s\S]*?)<!--\s*cont-inner\s+info-detail[^>]*?\/\/\s*-->/)
            const region = m ? m[1] : ''
            if (!region) return []
            const div = document.createElement('div')
            div.innerHTML = region
            const links = []
            div.querySelectorAll('a[href]').forEach(el => {
              const href = el.getAttribute('href')
              const text = el.textContent?.trim().substring(0, 60) || ''
              if (href) links.push({ href, text })
            })
            return links
          }, htmlSource)
        } else {
          rawLinks = await page.evaluate(() => {
            const links = []
            document.querySelectorAll('a[href], link[href]').forEach(el => {
              const href = el.getAttribute('href')
              const text = el.textContent?.trim().substring(0, 60) || el.tagName
              if (href) links.push({ href, text })
            })
            return links
          })
        }
        const resolvedLinks = rawLinks
          .map(l => ({ ...l, resolved: normalizeUrl(l.href, pageUrl) }))
          .filter(l => l.resolved !== null)
        const uniqueUrls = [...new Set(resolvedLinks.map(l => l.resolved))]
        const linkTextMap = {}
        resolvedLinks.forEach(l => { if (!linkTextMap[l.resolved]) linkTextMap[l.resolved] = l.text })
        const { results, total } = await checkDeadLinks(uniqueUrls, pageUrl, page)
        const dead = results.filter(r => !r.ok).map(r => ({ ...r, text: linkTextMap[r.url] || '' }))
        const redirects = results.filter(r => r.ok && r.redirectUrl).map(r => ({ ...r, text: linkTextMap[r.url] || '' }))
        const live = results.filter(r => r.ok).length
        linkResult = { engine: 'internal', dead, redirects, live, total, totalRaw: rawLinks.length, containerOnly, checkedAt: new Date().toISOString() }
      }
    }

    // ── W3C Markup Validation ──────────────────────────
    let w3cResult = { valid: null, errorCount: 0, warningCount: 0, fatalCount: 0, errors: [], warnings: [] }
    if (checkW3C) {
      // htmlSource는 이미 위에서 취득
      w3cResult = await validateW3C(htmlSource, pageUrl)
    }

    // ── KRDS 준수 검사 ─────────────────────────────────
    let krdsResult = null
    if (doCheckKRDS) {
      try {
        krdsResult = await checkKRDS(page, htmlSource, pageUrl)
      } catch (e) {
        console.error('[KRDS] 검사 오류:', e.message)
        krdsResult = { error: e.message, score: 0, passed: 0, failed: 0, total: 0, items: [] }
      }
    }

    await page.close()
    await browserPool.release(poolSlot)
    poolSlot = null

    return {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      scannedAt: new Date().toISOString(),
      url: pageUrl,
      originalUrl: url,
      pageTitle,
      level,
      score,
      summary: { violations: violations.length, passes, incomplete, inapplicable, impactCounts },
      violations,
      screenshot: screenshotBase64,
      spelling: spellingResult,
      links: linkResult,
      w3c: w3cResult,
      krds: krdsResult,
      status: 'completed'
    }
  } catch (err) {
    if (page) await page.close().catch(() => {})
    if (poolSlot) await browserPool.release(poolSlot).catch(() => {})
    // 연결 오류 메시지 친절하게 변환
    let errMsg = err.message
    if (errMsg.includes('ERR_CONNECTION_RESET'))  errMsg = '페이지 연결이 끊어졌습니다 (서버가 연결을 재설정했습니다)'
    else if (errMsg.includes('ERR_CONNECTION_REFUSED')) errMsg = '서버가 연결을 거부했습니다 (사이트가 다운되었을 수 있습니다)'
    else if (errMsg.includes('ERR_NAME_NOT_RESOLVED')) errMsg = 'DNS 조회 실패 (URL을 확인해주세요)'
    else if (errMsg.includes('Timeout') || errMsg.includes('timeout')) errMsg = '페이지 로딩 시간 초과 (20초) — 사이트가 느리거나 응답하지 않습니다'
    else if (errMsg.includes('Execution context was destroyed')) errMsg = '페이지 이동 중 컨텍스트가 변경되었습니다 (리다이렉션 발생)'
    return {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      scannedAt: new Date().toISOString(),
      url,
      originalUrl: url,
      pageTitle: '',
      level,
      score: 0,
      summary: { violations: 0, passes: 0, incomplete: 0, inapplicable: 0, impactCounts: {} },
      violations: [],
      screenshot: null,
      spelling: { issues: [], totalWords: 0, totalIssues: 0 },
      links: { dead: [], redirects: [], live: 0, total: 0 },
      w3c: { valid: null, errorCount: 0, warningCount: 0, fatalCount: 0, errors: [], warnings: [] },
      krds: null,
      status: 'error',
      error: errMsg
    }
  }
}

// 배치 스캔 시작
app.post('/api/batch/start', async (req, res) => {
  const { urls, options = {} } = req.body
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls 배열이 필요합니다.' })
  }
  // 최대 100,000개 지원 (메모리 경고 제공)
  const MAX_BATCH = 100000
  if (urls.length > MAX_BATCH) {
    return res.status(400).json({ error: `최대 ${MAX_BATCH.toLocaleString()}개 URL까지 가능합니다.` })
  }

  const sessionId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2)
  const session = {
    id: sessionId,
    label: `${urls.length.toLocaleString()}개 페이지 검사 (${new Date().toLocaleString('ko-KR')})`,
    createdAt: new Date().toISOString(),
    total: urls.length,
    completed: 0,
    failed: 0,
    status: 'running',
    results: [],
    options,
    urls
  }
  batchSessions.set(sessionId, session)

  res.json({ sessionId, total: urls.length, message: '배치 스캔이 시작되었습니다.' })

  // 백그라운드 실행 — 큐 기반 워커 (BATCH_CONCURRENCY 동시)
  ;(async () => {
    let idx = 0
    const workers = Array.from({ length: BATCH_CONCURRENCY }, async () => {
      while (true) {
        const i = idx++
        if (i >= urls.length) break
        const url = urls[i]
        try {
          const result = await scanSinglePage(url, options)
          // 전체 결과는 evidenceStore에 보관 (상세 조회용)
          addEvidence(result.id, result)
          // 배치 results는 경량화 버전만 (메모리 절약)
          session.results[i] = lightResult(result)
          if (result.status === 'error') session.failed++
          else session.completed++
        } catch (err) {
          session.failed++
          session.results[i] = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2),
            url, status: 'error', error: err.message,
            score: 0, summary: { violations:0,passes:0,incomplete:0,inapplicable:0,impactCounts:{} },
            spelling:{totalIssues:0,totalWords:0},
            links:{dead:0,redirects:0,live:0,total:0}, w3c:null, krds:null,
            scannedAt: new Date().toISOString()
          }
        }
        // 중간 진행도 업데이트
        const done = session.completed + session.failed
        session.progress = Math.round(done / urls.length * 100)
      }
    })
    await Promise.allSettled(workers)
    session.status = 'completed'
    session.finishedAt = new Date().toISOString()
    console.log(`[배치완료] ${sessionId}: ${session.completed}완료/${session.failed}오류`)
  })()
})

// ─── 전체 민원안내 페이지 일괄 검사 (all-urls 수집 후 자동 배치 시작) ──────
// 1) /api/minwon/all-urls 로 전체 URL 수집 (쿼리 옵션 지원)
// 2) 1000개 단위로 분할하여 여러 배치 세션 생성
// 3) 첫 번째 세션 ID 반환 + 전체 세션 목록도 함께 반환
app.post('/api/batch/start-all', async (req, res) => {
  const { query = '', options = {}, chunkSize = 1000 } = req.body
  const safeChunk = Math.min(Math.max(parseInt(chunkSize) || 1000, 1), 1000)

  try {
    // 전체 URL 수집
    const PAGE_BATCH = 200
    let startCount = 0
    const seenCds = new Set()
    const allItems = []

    const first = await fetchMinwonPage(query, 0, PAGE_BATCH)
    const total = first.total
    for (const item of first.items) {
      if (!seenCds.has(item.cappBizCd)) { seenCds.add(item.cappBizCd); allItems.push(item) }
    }
    startCount += PAGE_BATCH

    const remaining = Math.ceil((total - PAGE_BATCH) / PAGE_BATCH)
    const batches = []
    for (let i = 0; i < remaining; i++) batches.push(startCount + i * PAGE_BATCH)

    const PARALLEL = 20
    for (let i = 0; i < batches.length; i += PARALLEL) {
      const chunk = batches.slice(i, i + PARALLEL)
      const results = await Promise.allSettled(chunk.map(sc => fetchMinwonPage(query, sc, PAGE_BATCH)))
      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const item of r.value.items) {
            if (!seenCds.has(item.cappBizCd)) { seenCds.add(item.cappBizCd); allItems.push(item) }
          }
        }
      }
    }

    if (allItems.length === 0) {
      return res.status(404).json({ error: '검사할 URL이 없습니다.' })
    }

    // safeChunk 단위로 분할하여 배치 세션 생성
    const sessionIds = []
    for (let i = 0; i < allItems.length; i += safeChunk) {
      const chunk = allItems.slice(i, i + safeChunk)
      const urls = chunk.map(item => ({ url: item.url, title: item.title, category: item.category, department: item.department }))
      const sessionId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2)
      const session = {
        id: sessionId,
        createdAt: new Date().toISOString(),
        total: urls.length,
        completed: 0,
        failed: 0,
        status: 'running',
        results: [],
        options,
        urls,
        chunkIndex: Math.floor(i / safeChunk),
        totalChunks: Math.ceil(allItems.length / safeChunk)
      }
      batchSessions.set(sessionId, session)
      sessionIds.push(sessionId)

      // 각 세션을 백그라운드에서 병렬 처리 (BATCH_CONCURRENCY 개 동시)
      ;(async (sess, urlList) => {
        let jIdx = 0, done = 0
        const workers = Array.from({ length: BATCH_CONCURRENCY }, async () => {
          while (true) {
            const j = jIdx++
            if (j >= urlList.length) break
            const entry = urlList[j]
            const urlStr = typeof entry === 'string' ? entry : entry.url
            try {
              const result = await scanSinglePage(urlStr, options)
              if (typeof entry === 'object') {
                result.category = result.category || entry.category
                result.department = result.department || entry.department
              }
              addEvidence(result.id, result)
              sess.results.push(lightResult(result))
              if (result.status === 'error') sess.failed++
              else sess.completed++
            } catch (err) {
              sess.failed++
              sess.results.push({ url: urlStr, status: 'error', error: err.message,
                id: Date.now().toString(36) + Math.random().toString(36).slice(2),
                score: 0, summary: {violations:0,passes:0,incomplete:0,inapplicable:0,impactCounts:{}} })
            }
            done++
            sess.progress = Math.round(done / urlList.length * 100)
          }
        })
        await Promise.allSettled(workers)
        sess.status = 'completed'
        sess.finishedAt = new Date().toISOString()
      })(session, urls)
    }

    res.json({
      totalUrls: allItems.length,
      totalSessions: sessionIds.length,
      chunkSize: safeChunk,
      sessionIds,
      firstSessionId: sessionIds[0],
      message: `${allItems.length}개 URL을 ${sessionIds.length}개 세션으로 분할하여 검사를 시작합니다.`
    })
  } catch (err) {
    console.error('전체 검사 시작 오류:', err.message)
    res.status(500).json({ error: '전체 검사 시작 실패: ' + err.message })
  }
})

// 배치 스캔 상태 조회
app.get('/api/batch/:sessionId/status', (req, res) => {
  const session = batchSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' })
  const done = (session.completed||0) + (session.failed||0)
  res.json({
    id: session.id,
    status: session.status,
    total: session.total,
    completed: done,          // 폴링 UI에서 완료수로 사용 (성공+실패)
    succeeded: session.completed,
    failed: session.failed,
    progress: session.progress || 0,
    createdAt: session.createdAt,
    finishedAt: session.finishedAt
  })
})

// 배치 스캔 결과 조회
app.get('/api/batch/:sessionId/results', (req, res) => {
  const session = batchSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' })
  
  // 스크린샷 제외 (목록용)
  const results = session.results.map(r => ({
    ...r,
    screenshot: r.screenshot ? '[screenshot_available]' : null
  }))
  
  res.json({
    id: session.id,
    status: session.status,
    total: session.total,
    completed: session.completed,
    failed: session.failed,
    progress: session.progress || 0,
    createdAt: session.createdAt,
    finishedAt: session.finishedAt,
    results
  })
})

// 개별 증적 조회 (스크린샷 포함)
app.get('/api/evidence/:evidenceId', (req, res) => {
  const evidence = evidenceStore.get(req.params.evidenceId)
  if (!evidence) return res.status(404).json({ error: '증적을 찾을 수 없습니다.' })
  res.json(evidence)
})

// 개별 증적 HTML 보고서 다운로드
app.get('/api/evidence/:evidenceId/report', (req, res) => {
  const evidence = evidenceStore.get(req.params.evidenceId)
  if (!evidence) return res.status(404).json({ error: '증적을 찾을 수 없습니다.' })
  
  // 기존 report API와 동일한 HTML 생성 로직 재사용
  const html = generateReportHtml(evidence)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="evidence-${evidence.id}.html"`)
  res.send(html)
})

// 배치 전체 보고서 다운로드
app.get('/api/batch/:sessionId/report', (req, res) => {
  const session = batchSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' })
  if (session.status !== 'completed') return res.status(400).json({ error: '스캔이 아직 완료되지 않았습니다.' })

  const html = generateBatchReportHtml(session)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="batch-report-${session.id}.html"`)
  res.send(html)
})

// ─── 배치 결과 엑셀 다운로드 API ─────────────────────
app.get('/api/batch/:sessionId/excel', async (req, res) => {
  const session = batchSessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: '세션을 찾을 수 없습니다.' })

  try {
    const wb = new ExcelJS.Workbook()
    wb.creator = '가디언즈 오브 겔럭시'
    wb.created = new Date()

    // ── 시트 1: 종합 현황 ─────────────────────────────
    const summaryWs = wb.addWorksheet('종합 현황')
    summaryWs.columns = [
      { header: '항목', key: 'label', width: 28 },
      { header: '값', key: 'value', width: 40 }
    ]
    const headerStyle = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }, alignment: { horizontal: 'center' } }
    summaryWs.getRow(1).eachCell(c => Object.assign(c, headerStyle))

    const completedResults = session.results.filter(r => r.status !== 'error')
    const avgScore = completedResults.length > 0
      ? Math.round(completedResults.reduce((s, r) => s + (r.score || 0), 0) / completedResults.length) : 0
    const totalViol = session.results.reduce((s, r) => s + (r.summary?.violations || 0), 0)
    const totalSpell = session.results.reduce((s, r) => s + (r.spelling?.totalIssues || 0), 0)
    const totalDead = session.results.reduce((s, r) => s + (r.links?.dead?.length || 0), 0)
    const totalW3cErr = session.results.reduce((s, r) => s + (r.w3c?.errorCount || 0), 0)
    const totalW3cWarn = session.results.reduce((s, r) => s + (r.w3c?.warningCount || 0), 0)
    const w3cInvalid = session.results.filter(r => r.w3c?.valid === false).length
    const errored = session.results.filter(r => r.status === 'error').length

    const summaryData = [
      ['검사 세션 ID', session.id],
      ['검사 시작 일시', new Date(session.createdAt).toLocaleString('ko-KR')],
      ['검사 완료 일시', session.finishedAt ? new Date(session.finishedAt).toLocaleString('ko-KR') : '진행 중'],
      ['검사 대상 URL 수', session.total],
      ['성공', session.completed],
      ['오류', errored],
      ['─ 접근성 검사 ─', ''],
      ['평균 접근성 점수 (0~100)', avgScore],
      ['총 접근성 위반 건수', totalViol],
      ['WCAG 검사 수준', session.options?.level || 'wcag2aa'],
      ['─ 오탈자 검사 ─', ''],
      ['총 오탈자 건수', totalSpell],
      ['─ 링크 검사 ─', ''],
      ['총 데드링크 건수', totalDead],
      ['─ W3C 표준 검사 ─', ''],
      ['W3C 검사 수행 여부', session.results.some(r => r.w3c?.errorCount !== undefined && r.w3c.checkedAt) ? '예' : '미수행'],
      ['W3C 오류 발생 페이지 수', w3cInvalid],
      ['W3C 총 오류 건수', totalW3cErr],
      ['W3C 총 경고 건수', totalW3cWarn],
    ]
    summaryData.forEach(([label, value]) => {
      const row = summaryWs.addRow({ label, value })
      row.getCell('label').font = { bold: true }
      row.getCell('label').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
    })
    summaryWs.getColumn('label').border = { right: { style: 'thin', color: { argb: 'FFE2E8F0' } } }

    // ── 시트 2: 페이지별 결과 ─────────────────────────
    const ws = wb.addWorksheet('페이지별 결과')
    ws.columns = [
      { header: 'No.', key: 'no', width: 6 },
      { header: '페이지 제목', key: 'title', width: 36 },
      { header: 'URL (www.gov.kr/mw)', key: 'url', width: 52 },
      { header: '카테고리', key: 'category', width: 18 },
      { header: '부서', key: 'department', width: 18 },
      { header: '접근성 점수', key: 'score', width: 13 },
      { header: '위반 수', key: 'violations', width: 10 },
      { header: '통과 수', key: 'passes', width: 10 },
      { header: '치명적', key: 'critical', width: 9 },
      { header: '심각', key: 'serious', width: 9 },
      { header: '보통', key: 'moderate', width: 9 },
      { header: '경미', key: 'minor', width: 9 },
      { header: '오탈자 수', key: 'spelling', width: 10 },
      { header: '검사 어절 수', key: 'words', width: 12 },
      { header: '데드링크 수', key: 'deadLinks', width: 12 },
      { header: '리다이렉트 수', key: 'redirects', width: 13 },
      { header: '정상 링크 수', key: 'liveLinks', width: 12 },
      { header: '전체 링크 수', key: 'totalLinks', width: 12 },
      { header: 'W3C 오류', key: 'w3cErrors', width: 11 },
      { header: 'W3C 경고', key: 'w3cWarnings', width: 11 },
      { header: 'W3C 유효성', key: 'w3cValid', width: 12 },
      { header: '검사 상태', key: 'status', width: 10 },
      { header: '검사 일시', key: 'scannedAt', width: 22 },
      { header: '오류 메시지', key: 'errorMsg', width: 40 }
    ]

    // 헤더 스타일
    ws.getRow(1).eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false }
      c.border = { bottom: { style: 'medium', color: { argb: 'FF2563EB' } } }
    })
    ws.getRow(1).height = 22

    // 데이터 행
    session.results.forEach((r, idx) => {
      const imp = r.summary?.impactCounts || {}
      const sp = r.spelling || {}
      const lk = r.links || {}
      const w3c = r.w3c || {}
      const score = r.score ?? null
      const isError = r.status === 'error'

      const row = ws.addRow({
        no: idx + 1,
        title: r.pageTitle || '(오류)',
        url: r.url || r.originalUrl || '',
        category: r.category || '',
        department: r.department || '',
        score: score,
        violations: r.summary?.violations ?? '',
        passes: r.summary?.passes ?? '',
        critical: imp.critical || 0,
        serious: imp.serious || 0,
        moderate: imp.moderate || 0,
        minor: imp.minor || 0,
        spelling: sp.totalIssues ?? '',
        words: sp.totalWords ?? '',
        deadLinks: lk.dead?.length ?? '',
        redirects: lk.redirects?.length ?? '',
        liveLinks: lk.live ?? '',
        totalLinks: lk.total ?? '',
        w3cErrors: w3c.errorCount ?? '',
        w3cWarnings: w3c.warningCount ?? '',
        w3cValid: w3c.valid === null ? '' : w3c.valid ? '유효' : '무효',
        status: isError ? '오류' : '완료',
        scannedAt: r.scannedAt ? new Date(r.scannedAt).toLocaleString('ko-KR') : '',
        errorMsg: r.error || ''
      })

      // 행 배경 (짝수 줄 연회색)
      const bg = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
      row.eachCell(c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
        c.font = { size: 9 }
        c.alignment = { vertical: 'middle' }
      })

      // 점수 색상
      if (score !== null) {
        const scoreCell = row.getCell('score')
        scoreCell.font = { bold: true, size: 10, color: { argb: score >= 80 ? 'FF16A34A' : score >= 50 ? 'FFD97706' : 'FFDC2626' } }
        scoreCell.alignment = { horizontal: 'center', vertical: 'middle' }
      }

      // 위반 수 빨간색
      if ((r.summary?.violations || 0) > 0) {
        const vc = row.getCell('violations')
        vc.font = { bold: true, color: { argb: 'FFDC2626' }, size: 10 }
        vc.alignment = { horizontal: 'center', vertical: 'middle' }
      }

      // 치명적/심각 색상
      if ((imp.critical || 0) > 0) row.getCell('critical').font = { bold: true, color: { argb: 'FFDC2626' }, size: 9 }
      if ((imp.serious || 0) > 0) row.getCell('serious').font = { bold: true, color: { argb: 'FFEA580C' }, size: 9 }

      // 오탈자 색상
      if ((sp.totalIssues || 0) > 0) {
        row.getCell('spelling').font = { bold: true, color: { argb: 'FF7C3AED' }, size: 10 }
      }

      // 데드링크 색상
      if ((lk.dead?.length || 0) > 0) {
        row.getCell('deadLinks').font = { bold: true, color: { argb: 'FFDC2626' }, size: 10 }
      }

      // W3C 오류 색상
      if ((w3c.errorCount || 0) > 0) {
        row.getCell('w3cErrors').font = { bold: true, color: { argb: 'FFDC2626' }, size: 10 }
      }
      if ((w3c.warningCount || 0) > 0) {
        row.getCell('w3cWarnings').font = { bold: true, color: { argb: 'FFD97706' }, size: 10 }
      }
      if (w3c.valid === false) {
        row.getCell('w3cValid').font = { bold: true, color: { argb: 'FFDC2626' }, size: 9 }
      } else if (w3c.valid === true) {
        row.getCell('w3cValid').font = { bold: true, color: { argb: 'FF16A34A' }, size: 9 }
      }
      row.getCell('w3cValid').alignment = { horizontal: 'center', vertical: 'middle' }

      // 상태 색상
      const stCell = row.getCell('status')
      stCell.font = { bold: true, color: { argb: isError ? 'FFDC2626' : 'FF16A34A' }, size: 9 }
      stCell.alignment = { horizontal: 'center', vertical: 'middle' }

      // 숫자 중앙 정렬
      ;['no', 'score', 'violations', 'passes', 'critical', 'serious', 'moderate', 'minor',
        'spelling', 'words', 'deadLinks', 'redirects', 'liveLinks', 'totalLinks',
        'w3cErrors', 'w3cWarnings'].forEach(k => {
        row.getCell(k).alignment = { horizontal: 'center', vertical: 'middle' }
      })

      row.height = 18
    })

    // 자동 필터
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } }

    // 틀 고정 (1행)
    ws.views = [{ state: 'frozen', ySplit: 1 }]

    // ── 시트 3: 접근성 위반 상세 ─────────────────────────
    const violWs = wb.addWorksheet('접근성 위반 상세')
    violWs.columns = [
      { header: 'No.', key: 'no', width: 6 },
      { header: '페이지 제목', key: 'title', width: 32 },
      { header: 'URL', key: 'url', width: 48 },
      { header: '규칙 ID', key: 'ruleId', width: 22 },
      { header: '심각도', key: 'impact', width: 10 },
      { header: '위반 내용', key: 'help', width: 40 },
      { header: '설명', key: 'description', width: 50 },
      { header: '영향받는 요소 수', key: 'nodeCount', width: 16 },
      { header: '첫 번째 요소 HTML', key: 'firstHtml', width: 60 }
    ]
    violWs.getRow(1).eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7F1D1D' } }
      c.alignment = { horizontal: 'center', vertical: 'middle' }
    })
    violWs.getRow(1).height = 22

    const impactOrder = { critical: 1, serious: 2, moderate: 3, minor: 4 }
    const impactColorArgb = { critical: 'FFDC2626', serious: 'FFEA580C', moderate: 'FFD97706', minor: 'FF65A30D' }
    const impactLabelKo = { critical: '치명적', serious: '심각', moderate: '보통', minor: '경미' }
    let violRowIdx = 0
    session.results.forEach(r => {
      if (!r.violations || r.violations.length === 0) return
      const sorted = [...r.violations].sort((a, b) => (impactOrder[a.impact] || 9) - (impactOrder[b.impact] || 9))
      sorted.forEach(v => {
        const row = violWs.addRow({
          no: ++violRowIdx,
          title: r.pageTitle || '',
          url: r.url || '',
          ruleId: v.id,
          impact: impactLabelKo[v.impact] || v.impact,
          help: v.help,
          description: v.description,
          nodeCount: v.nodes?.length || 0,
          firstHtml: v.nodes?.[0]?.html?.substring(0, 200) || ''
        })
        const bg = violRowIdx % 2 === 0 ? 'FFFFFFFF' : 'FFFFF1F2'
        row.eachCell(c => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
          c.font = { size: 9 }
          c.alignment = { vertical: 'middle', wrapText: false }
        })
        const impCell = row.getCell('impact')
        impCell.font = { bold: true, color: { argb: impactColorArgb[v.impact] || 'FF6B7280' }, size: 9 }
        impCell.alignment = { horizontal: 'center', vertical: 'middle' }
        row.getCell('no').alignment = { horizontal: 'center', vertical: 'middle' }
        row.height = 16
      })
    })
    violWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: violWs.columns.length } }
    violWs.views = [{ state: 'frozen', ySplit: 1 }]

    // ── 시트 4: 오탈자 상세 ──────────────────────────────
    const spellWs = wb.addWorksheet('오탈자 상세')
    spellWs.columns = [
      { header: 'No.', key: 'no', width: 6 },
      { header: '페이지 제목', key: 'title', width: 32 },
      { header: 'URL', key: 'url', width: 48 },
      { header: '오탈자', key: 'word', width: 18 },
      { header: '수정 제안', key: 'suggestion', width: 18 },
      { header: '설명', key: 'desc', width: 40 },
      { header: '문맥', key: 'context', width: 50 }
    ]
    spellWs.getRow(1).eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4C1D95' } }
      c.alignment = { horizontal: 'center', vertical: 'middle' }
    })
    spellWs.getRow(1).height = 22

    let spellRowIdx = 0
    session.results.forEach(r => {
      if (!r.spelling?.issues?.length) return
      r.spelling.issues.forEach(issue => {
        const row = spellWs.addRow({
          no: ++spellRowIdx,
          title: r.pageTitle || '',
          url: r.url || '',
          word: issue.word,
          suggestion: issue.suggestion,
          desc: issue.desc || '',
          context: issue.context ? `...${issue.context}...` : ''
        })
        const bg = spellRowIdx % 2 === 0 ? 'FFFFFFFF' : 'FFFAF5FF'
        row.eachCell(c => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
          c.font = { size: 9 }
          c.alignment = { vertical: 'middle' }
        })
        row.getCell('word').font = { bold: true, color: { argb: 'FF7C3AED' }, size: 9 }
        row.getCell('suggestion').font = { bold: true, color: { argb: 'FF059669' }, size: 9 }
        row.getCell('no').alignment = { horizontal: 'center', vertical: 'middle' }
        row.height = 16
      })
    })
    spellWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spellWs.columns.length } }
    spellWs.views = [{ state: 'frozen', ySplit: 1 }]

    // ── 시트 5: 데드링크 상세 ────────────────────────────
    const linkWs = wb.addWorksheet('데드링크 상세')
    linkWs.columns = [
      { header: 'No.', key: 'no', width: 6 },
      { header: '페이지 제목', key: 'title', width: 32 },
      { header: '페이지 URL', key: 'pageUrl', width: 48 },
      { header: '데드링크 URL', key: 'linkUrl', width: 56 },
      { header: '링크 텍스트', key: 'linkText', width: 28 },
      { header: 'HTTP 상태', key: 'status', width: 12 },
      { header: '오류 메시지', key: 'error', width: 36 }
    ]
    linkWs.getRow(1).eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7F1D1D' } }
      c.alignment = { horizontal: 'center', vertical: 'middle' }
    })
    linkWs.getRow(1).height = 22

    let linkRowIdx = 0
    session.results.forEach(r => {
      if (!r.links?.dead?.length) return
      r.links.dead.forEach(link => {
        const row = linkWs.addRow({
          no: ++linkRowIdx,
          title: r.pageTitle || '',
          pageUrl: r.url || '',
          linkUrl: link.url,
          linkText: link.text || '',
          status: link.status || '오류',
          error: link.error || ''
        })
        const bg = linkRowIdx % 2 === 0 ? 'FFFFFFFF' : 'FFFFF1F2'
        row.eachCell(c => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
          c.font = { size: 9 }
          c.alignment = { vertical: 'middle' }
        })
        row.getCell('status').font = { bold: true, color: { argb: 'FFDC2626' }, size: 9 }
        row.getCell('status').alignment = { horizontal: 'center', vertical: 'middle' }
        row.getCell('no').alignment = { horizontal: 'center', vertical: 'middle' }
        row.height = 16
      })
    })
    linkWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: linkWs.columns.length } }
    linkWs.views = [{ state: 'frozen', ySplit: 1 }]

    // ── 시트 5: W3C 위반 상세 ────────────────────────────
    const w3cWs = wb.addWorksheet('W3C 위반 상세')
    w3cWs.columns = [
      { header: 'No.', key: 'no', width: 6 },
      { header: '페이지 제목', key: 'title', width: 32 },
      { header: 'URL', key: 'url', width: 48 },
      { header: '유형', key: 'type', width: 10 },
      { header: '세부유형', key: 'subType', width: 10 },
      { header: '오류 메시지', key: 'message', width: 60 },
      { header: '문제 코드', key: 'extract', width: 50 },
      { header: '행', key: 'lastLine', width: 8 },
      { header: '열', key: 'lastColumn', width: 8 }
    ]
    w3cWs.getRow(1).eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      c.alignment = { horizontal: 'center', vertical: 'middle' }
    })
    w3cWs.getRow(1).height = 22

    let w3cRowIdx = 0
    session.results.forEach(r => {
      const w3c = r.w3c
      if (!w3c || (!w3c.errors?.length && !w3c.warnings?.length)) return
      const allMsgs = [
        ...(w3c.errors || []).map(m => ({ ...m, _level: 'error' })),
        ...(w3c.warnings || []).map(m => ({ ...m, _level: 'warning' }))
      ]
      allMsgs.forEach(m => {
        const row = w3cWs.addRow({
          no: ++w3cRowIdx,
          title: r.pageTitle || '',
          url: r.url || '',
          type: m._level === 'error' ? '오류' : '경고',
          subType: m.subType === 'fatal' ? '치명적' : m.subType || '',
          message: m.message || '',
          extract: m.extract ? m.extract.substring(0, 200) : '',
          lastLine: m.lastLine || '',
          lastColumn: m.lastColumn || ''
        })
        const bg = w3cRowIdx % 2 === 0 ? 'FFFFFFFF' : 'FFEFF6FF'
        row.eachCell(c => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
          c.font = { size: 9 }
          c.alignment = { vertical: 'middle', wrapText: false }
        })
        const typeCell = row.getCell('type')
        typeCell.font = {
          bold: true, size: 9,
          color: { argb: m._level === 'error' ? 'FFDC2626' : 'FFD97706' }
        }
        typeCell.alignment = { horizontal: 'center', vertical: 'middle' }
        if (m.subType === 'fatal') {
          row.getCell('subType').font = { bold: true, color: { argb: 'FF7C0000' }, size: 9 }
        }
        row.getCell('no').alignment = { horizontal: 'center', vertical: 'middle' }
        ;['lastLine','lastColumn'].forEach(k => row.getCell(k).alignment = { horizontal: 'center', vertical: 'middle' })
        row.height = 16
      })
    })
    w3cWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: w3cWs.columns.length } }
    w3cWs.views = [{ state: 'frozen', ySplit: 1 }]

    // 엑셀 출력
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const filename = `minwon-a11y-report-${dateStr}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    await wb.xlsx.write(res)
    res.end()

  } catch (err) {
    console.error('엑셀 생성 오류:', err.message)
    res.status(500).json({ error: '엑셀 생성 실패: ' + err.message })
  }
})
function generateReportHtml(result) {
  const impactColor = { critical: '#dc2626', serious: '#ea580c', moderate: '#d97706', minor: '#65a30d' }
  const impactLabel = { critical: '치명적', serious: '심각', moderate: '보통', minor: '경미' }
  const scoreColor = result.score >= 80 ? '#22c55e' : result.score >= 50 ? '#f59e0b' : '#ef4444'

  const violationsHtml = result.violations.map((v, i) => `
    <div style="border-left:4px solid ${impactColor[v.impact]||'#6b7280'};margin-bottom:16px;padding:12px 16px;background:#fafafa;border-radius:0 8px 8px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong style="font-size:14px;color:#1e293b;">${i+1}. ${escapeHtml(v.help)}</strong>
        <span style="background:${impactColor[v.impact]||'#6b7280'};color:white;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;">${impactLabel[v.impact]||v.impact}</span>
      </div>
      <p style="color:#475569;font-size:12px;margin-bottom:6px;">${escapeHtml(v.description)}</p>
      <div style="font-size:11px;color:#64748b;margin-bottom:6px;"><strong>규칙:</strong> ${v.id} | <a href="${v.helpUrl}" style="color:#3b82f6;">가이드 →</a></div>
      <div style="background:#f1f5f9;border-radius:6px;padding:8px;font-size:11px;">
        ${v.nodes.slice(0,3).map(n=>`<div style="font-family:monospace;background:#e2e8f0;padding:3px 6px;border-radius:3px;margin-top:4px;word-break:break-all;">${escapeHtml(n.html)}</div><div style="color:#64748b;margin-top:2px;">${escapeHtml(n.failureSummary||'')}</div>`).join('')}
        ${v.nodes.length>3?`<div style="color:#94a3b8;margin-top:4px;">... 외 ${v.nodes.length-3}개</div>`:''}
      </div>
    </div>`).join('')

  const sp = result.spelling || {}
  const _SPELL_TYPE_LABEL = { spell: '철자 오류', spacing: '띄어쓰기', ambiguous: '문맥 오류', stat: '통계 교정', korean: '한글', unknown: '기타' }
  const _SPELL_TYPE_COLOR = { spell: '#dc2626', spacing: '#d97706', ambiguous: '#ea580c', stat: '#2563eb', korean: '#8b5cf6', unknown: '#6b7280' }
  const spellingHtml = (sp.issues && sp.issues.length > 0) ? sp.issues.map((issue, i) => {
    const tc = _SPELL_TYPE_COLOR[issue.type] || '#8b5cf6'
    const tl = _SPELL_TYPE_LABEL[issue.type] || '기타'
    const lineInfo = issue.line ? `줄 ${issue.line}${issue.col ? ', 열 '+issue.col : ''}` : ''
    return `
    <div style="border-left:4px solid ${tc};margin-bottom:12px;padding:10px 14px;background:#fafafa;border-radius:0 6px 6px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="font-size:13px;color:#1e293b;">
          <strong style="color:#dc2626;">"${escapeHtml(issue.word)}"</strong>
          <span style="color:#94a3b8;margin:0 6px;">→</span>
          <strong style="color:#059669;">"${escapeHtml(issue.suggestion)}"</strong>
        </span>
        <span style="background:${tc};color:white;padding:1px 8px;border-radius:10px;font-size:10px;">${tl}</span>
      </div>
      ${issue.desc?`<div style="font-size:11px;color:#64748b;margin-bottom:4px;">${escapeHtml(issue.desc)}</div>`:''}
      ${issue.context?`<div style="font-family:monospace;font-size:11px;background:#e2e8f0;padding:3px 8px;border-radius:4px;color:#475569;margin-bottom:4px;">${escapeHtml(issue.context)}</div>`:''}
      <div style="font-size:11px;color:#94a3b8;display:flex;gap:12px;flex-wrap:wrap;">
        ${lineInfo ? `<span>📍 ${lineInfo}</span>` : ''}
        ${issue.pageUrl ? `<span>🔗 ${escapeHtml(issue.pageUrl)}</span>` : ''}
      </div>
    </div>`
  }).join('') : '<div style="text-align:center;padding:24px;color:#22c55e;font-weight:600;">✅ 오탈자가 감지되지 않았습니다.</div>'


  const lk = result.links || {}
  const deadLinksHtml = (lk.dead && lk.dead.length > 0) ? lk.dead.map((link, i) => `
    <div style="border-left:4px solid #ef4444;margin-bottom:12px;padding:10px 14px;background:#fef2f2;border-radius:0 6px 6px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <code style="font-size:11px;color:#1e293b;word-break:break-all;">${escapeHtml(link.url)}</code>
        <span style="background:#ef4444;color:white;padding:1px 8px;border-radius:10px;font-size:10px;white-space:nowrap;margin-left:8px;">${link.status||'오류'}</span>
      </div>
      ${link.text?`<div style="font-size:12px;color:#64748b;">링크 텍스트: "${escapeHtml(link.text)}"</div>`:''}
      ${link.error?`<div style="font-size:11px;color:#dc2626;margin-top:2px;">⚠ ${escapeHtml(link.error)}</div>`:''}
    </div>`).join('') : '<div style="text-align:center;padding:24px;color:#22c55e;font-weight:600;">✅ 데드링크가 발견되지 않았습니다.</div>'

  const screenshotSection = result.screenshot ? `
    <div class="section"><h2>📸 페이지 스크린샷</h2>
      <img src="data:image/png;base64,${result.screenshot}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;" />
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>증적 보고서 - ${escapeHtml(result.pageTitle || result.url)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Apple SD Gothic Neo','Malgun Gothic',Arial,sans-serif;background:#f8fafc;color:#1e293b}
  .header{background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:white;padding:36px 40px}
  .header h1{font-size:26px;font-weight:700;margin-bottom:6px}
  .meta{font-size:12px;opacity:.85;margin-top:3px}
  .container{max-width:960px;margin:0 auto;padding:28px 20px}
  .section{background:white;border-radius:12px;padding:24px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  .section h2{font-size:17px;font-weight:700;margin-bottom:16px;color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:8px}
  .score-num{font-size:68px;font-weight:800;color:${scoreColor};line-height:1}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  .stat{text-align:center;padding:14px;background:#f8fafc;border-radius:8px}
  .stat-num{font-size:28px;font-weight:700}
  .impact-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .impact-item{padding:12px;border-radius:8px;text-align:center}
  .impact-item .num{font-size:26px;font-weight:700;color:white}
  .impact-item .lbl{font-size:11px;color:rgba(255,255,255,.9);margin-top:2px}
  .summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
  .sum-box{padding:14px;border-radius:8px;text-align:center;border:1px solid}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600}
  .footer{text-align:center;color:#94a3b8;font-size:11px;margin-top:28px;padding-bottom:36px}
  @media print{body{background:white}.header{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="header">
  <div style="max-width:960px;margin:0 auto">
    <h1>🔍 웹 품질 종합 검사 증적 보고서</h1>
    <div class="meta">🌐 URL: ${escapeHtml(result.url)}</div>
    <div class="meta">📄 제목: ${escapeHtml(result.pageTitle||'알 수 없음')}</div>
    <div class="meta">📅 검사 일시: ${new Date(result.scannedAt).toLocaleString('ko-KR')}</div>
    <div class="meta">🆔 증적 ID: ${result.id}</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <span class="badge" style="background:rgba(255,255,255,.2)">♿ 접근성 ${(result.level||'wcag2aa').toUpperCase()}</span>
      <span class="badge" style="background:rgba(255,255,255,.2)">✍️ 오탈자 검사</span>
      <span class="badge" style="background:rgba(255,255,255,.2)">🔗 링크 검사</span>
      ${result.w3c?.checkedAt ? `<span class="badge" style="background:rgba(255,255,255,.2)">🏷️ W3C 표준 검사</span>` : ''}
    </div>
  </div>
</div>
<div class="container">
  <div class="section">
    <h2>📊 종합 검사 현황</h2>
    <div class="summary-grid">
      <div class="sum-box" style="background:#fef2f2;border-color:#fecaca">
        <div style="font-size:11px;font-weight:600;color:#dc2626;margin-bottom:4px">♿ 접근성 위반</div>
        <div style="font-size:32px;font-weight:800;color:#dc2626">${result.summary.violations}</div>
        <div style="font-size:11px;color:#64748b">점수: ${result.score}/100</div>
      </div>
      <div class="sum-box" style="background:${sp.totalIssues>0?'#faf5ff':'#f0fdf4'};border-color:${sp.totalIssues>0?'#ddd6fe':'#bbf7d0'}">
        <div style="font-size:11px;font-weight:600;color:${sp.totalIssues>0?'#7c3aed':'#16a34a'};margin-bottom:4px">✍️ 오탈자</div>
        <div style="font-size:32px;font-weight:800;color:${sp.totalIssues>0?'#7c3aed':'#16a34a'}">${sp.totalIssues||0}</div>
        <div style="font-size:11px;color:#64748b">총 ${sp.totalWords||0}개 단어 검사</div>
      </div>
      <div class="sum-box" style="background:${lk.dead&&lk.dead.length>0?'#fef2f2':'#f0fdf4'};border-color:${lk.dead&&lk.dead.length>0?'#fecaca':'#bbf7d0'}">
        <div style="font-size:11px;font-weight:600;color:${lk.dead&&lk.dead.length>0?'#dc2626':'#16a34a'};margin-bottom:4px">🔗 데드링크</div>
        <div style="font-size:32px;font-weight:800;color:${lk.dead&&lk.dead.length>0?'#dc2626':'#16a34a'}">${lk.dead?lk.dead.length:0}</div>
        <div style="font-size:11px;color:#64748b">총 ${lk.total||0}개 링크 검사</div>
      </div>
    </div>
    ${result.w3c?.checkedAt ? `
    <div style="margin-top:12px;padding:12px 16px;border-radius:8px;background:${(result.w3c?.errorCount||0)>0?'#fef2f2':'#f0fdf4'};border:1px solid ${(result.w3c?.errorCount||0)>0?'#fecaca':'#bbf7d0'}">
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        <div style="font-size:11px;font-weight:700;color:#1e293b;min-width:120px">🏷️ W3C 표준 검사</div>
        <div style="text-align:center;min-width:70px">
          <div style="font-size:20px;font-weight:800;color:${(result.w3c?.errorCount||0)>0?'#dc2626':'#16a34a'}">${result.w3c?.errorCount||0}</div>
          <div style="font-size:10px;color:#64748b">오류</div>
        </div>
        <div style="text-align:center;min-width:70px">
          <div style="font-size:20px;font-weight:800;color:${(result.w3c?.warningCount||0)>0?'#d97706':'#16a34a'}">${result.w3c?.warningCount||0}</div>
          <div style="font-size:10px;color:#64748b">경고</div>
        </div>
        <div style="text-align:center;min-width:70px">
          <span style="font-size:13px;font-weight:700;padding:4px 12px;border-radius:20px;background:${result.w3c?.valid===true?'#dcfce7':result.w3c?.valid===false?'#fee2e2':'#f1f5f9'};color:${result.w3c?.valid===true?'#16a34a':result.w3c?.valid===false?'#dc2626':'#64748b'}">
            ${result.w3c?.valid===true?'✅ 유효':result.w3c?.valid===false?'❌ 무효':'⚪ 미검사'}
          </span>
        </div>
      </div>
    </div>` : ''}
  </div>
  <div class="section">
    <h2>♿ 접근성 검사 결과 (${(result.level||'wcag2aa').toUpperCase()})</h2>
    <div style="display:grid;grid-template-columns:1fr 2fr;gap:20px;align-items:center;margin-bottom:20px">
      <div style="text-align:center">
        <div class="score-num">${result.score}</div>
        <div style="font-size:14px;color:#64748b">/ 100점</div>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-num" style="color:#ef4444">${result.summary.violations}</div><div style="font-size:11px;color:#64748b">위반</div></div>
        <div class="stat"><div class="stat-num" style="color:#22c55e">${result.summary.passes}</div><div style="font-size:11px;color:#64748b">통과</div></div>
        <div class="stat"><div class="stat-num" style="color:#f59e0b">${result.summary.incomplete}</div><div style="font-size:11px;color:#64748b">검토필요</div></div>
        <div class="stat"><div class="stat-num" style="color:#94a3b8">${result.summary.inapplicable}</div><div style="font-size:11px;color:#64748b">해당없음</div></div>
      </div>
    </div>
    <div class="impact-grid">
      <div class="impact-item" style="background:#dc2626"><div class="num">${result.summary.impactCounts.critical||0}</div><div class="lbl">치명적</div></div>
      <div class="impact-item" style="background:#ea580c"><div class="num">${result.summary.impactCounts.serious||0}</div><div class="lbl">심각</div></div>
      <div class="impact-item" style="background:#d97706"><div class="num">${result.summary.impactCounts.moderate||0}</div><div class="lbl">보통</div></div>
      <div class="impact-item" style="background:#65a30d"><div class="num">${result.summary.impactCounts.minor||0}</div><div class="lbl">경미</div></div>
    </div>
    ${result.violations.length > 0 ? `<div style="margin-top:20px">${violationsHtml}</div>` : '<div style="text-align:center;padding:32px;color:#22c55e;font-size:16px;font-weight:700">🎉 위반 항목 없음!</div>'}
  </div>
  ${screenshotSection}
  <div class="section">
    <h2>✍️ 오탈자 검사 결과</h2>
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="background:#f5f3ff;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#7c3aed">${sp.koreanIssues||0}</div>
        <div style="font-size:11px;color:#64748b">한글 오탈자</div>
      </div>
      <div style="background:#f8fafc;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#64748b">${sp.totalWords||0}</div>
        <div style="font-size:11px;color:#64748b">검사 어절 수</div>
      </div>
    </div>
    ${spellingHtml}
  </div>
  <div class="section">
    <h2>🔗 링크 검사 결과</h2>
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="background:#fef2f2;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#dc2626">${lk.dead?lk.dead.length:0}</div>
        <div style="font-size:11px;color:#64748b">데드링크</div>
      </div>
      <div style="background:#f0fdf4;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#16a34a">${lk.live||0}</div>
        <div style="font-size:11px;color:#64748b">정상 링크</div>
      </div>
    </div>
    ${deadLinksHtml}
  </div>
  ${result.w3c?.checkedAt ? `
  <div class="section">
    <h2>🏷️ W3C 표준 검사 결과</h2>
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="background:${(result.w3c?.errorCount||0)>0?'#fef2f2':'#f0fdf4'};padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:${(result.w3c?.errorCount||0)>0?'#dc2626':'#16a34a'}">${result.w3c?.errorCount||0}</div>
        <div style="font-size:11px;color:#64748b">오류</div>
      </div>
      <div style="background:${(result.w3c?.warningCount||0)>0?'#fffbeb':'#f0fdf4'};padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:${(result.w3c?.warningCount||0)>0?'#d97706':'#16a34a'}">${result.w3c?.warningCount||0}</div>
        <div style="font-size:11px;color:#64748b">경고</div>
      </div>
      <div style="background:#f8fafc;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:13px;font-weight:700;padding:4px 8px;border-radius:12px;display:inline-block;background:${result.w3c?.valid===true?'#dcfce7':result.w3c?.valid===false?'#fee2e2':'#e2e8f0'};color:${result.w3c?.valid===true?'#16a34a':result.w3c?.valid===false?'#dc2626':'#64748b'}">
          ${result.w3c?.valid===true?'✅ 유효':result.w3c?.valid===false?'❌ 무효':'⚪ 미검사'}
        </div>
        <div style="font-size:11px;color:#64748b;margin-top:4px">유효성</div>
      </div>
      ${result.w3c?.fatalCount>0?`<div style="background:#fef2f2;padding:10px 16px;border-radius:8px;text-align:center;min-width:100px">
        <div style="font-size:22px;font-weight:800;color:#dc2626">${result.w3c?.fatalCount}</div>
        <div style="font-size:11px;color:#64748b">치명적 오류</div>
      </div>`:''}
    </div>
    ${result.w3c?.errors?.length > 0 ? `
    <div style="margin-bottom:12px"><strong style="font-size:13px;color:#dc2626">❌ 오류 목록 (${result.w3c.errors.length}건)</strong></div>
    ${result.w3c.errors.slice(0,20).map((e,i) => `
    <div style="border-left:4px solid #ef4444;margin-bottom:10px;padding:10px 14px;background:#fef2f2;border-radius:0 6px 6px 0;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1">
          <div style="font-size:12px;font-weight:600;color:#1e293b;margin-bottom:4px">${escapeHtml(e.message)}</div>
          ${e.extract?`<div style="font-family:monospace;font-size:11px;background:#fee2e2;padding:3px 8px;border-radius:4px;color:#7f1d1d;word-break:break-all">${escapeHtml(e.extract)}</div>`:''}
        </div>
        ${e.lastLine?`<span style="font-size:10px;color:#94a3b8;white-space:nowrap">L${e.lastLine}${e.lastColumn?':C'+e.lastColumn:''}</span>`:''}
      </div>
      ${e.subType==='fatal'?`<span style="background:#dc2626;color:white;font-size:10px;padding:1px 6px;border-radius:4px;margin-top:4px;display:inline-block">치명적</span>`:''}
    </div>`).join('')}
    ${result.w3c.errors.length > 20 ? `<div style="text-align:center;color:#94a3b8;font-size:12px;padding:8px">... 외 ${result.w3c.errors.length-20}건 (엑셀 보고서 참조)</div>` : ''}
    ` : '<div style="text-align:center;padding:20px;color:#22c55e;font-weight:600">✅ W3C 오류가 없습니다.</div>'}
    ${result.w3c?.warnings?.length > 0 ? `
    <div style="margin-top:12px;margin-bottom:8px"><strong style="font-size:13px;color:#d97706">⚠️ 경고 목록 (${result.w3c.warnings.length}건)</strong></div>
    ${result.w3c.warnings.slice(0,10).map((w,i) => `
    <div style="border-left:4px solid #f59e0b;margin-bottom:8px;padding:8px 12px;background:#fffbeb;border-radius:0 6px 6px 0;">
      <div style="font-size:12px;color:#1e293b;">${escapeHtml(w.message)}</div>
      ${w.extract?`<div style="font-family:monospace;font-size:11px;background:#fef3c7;padding:2px 6px;border-radius:3px;color:#78350f;margin-top:3px;word-break:break-all">${escapeHtml(w.extract)}</div>`:''}
    </div>`).join('')}
    ${result.w3c.warnings.length > 10 ? `<div style="text-align:center;color:#94a3b8;font-size:12px;padding:4px">... 외 ${result.w3c.warnings.length-10}건</div>` : ''}
    ` : ''}
    <div style="font-size:10px;color:#94a3b8;margin-top:8px">검사 기준: W3C Markup Validation Service (validator.w3.org/nu) | 검사 일시: ${result.w3c?.checkedAt ? new Date(result.w3c.checkedAt).toLocaleString('ko-KR') : '-'}</div>
  </div>` : ''}
  <div class="footer">
    <p>본 보고서는 가디언즈 오브 겔럭시 자동 검사 증적입니다. (axe-core + Playwright)</p>
    <p>생성: ${new Date().toLocaleString('ko-KR')}</p>
  </div>
</div>
</body>
</html>`
}

function generateBatchReportHtml(session) {
  const results = session.results
  const avgScore = results.filter(r => r.score !== undefined).length > 0
    ? Math.round(results.filter(r => r.score !== undefined).reduce((sum, r) => sum + (r.score || 0), 0) / results.filter(r => r.score !== undefined).length)
    : 0
  const totalViolations = results.reduce((sum, r) => sum + (r.summary?.violations || 0), 0)
  const totalSpelling = results.reduce((sum, r) => sum + (r.spelling?.totalIssues || 0), 0)
  const totalDeadLinks = results.reduce((sum, r) => sum + (r.links?.dead?.length || 0), 0)
  const totalW3cErrors = results.reduce((sum, r) => sum + (r.w3c?.errorCount || 0), 0)
  const w3cInvalidCount = results.filter(r => r.w3c?.valid === false).length
  const w3cChecked = results.some(r => r.w3c?.checkedAt)
  const errored = results.filter(r => r.status === 'error').length

  const rowsHtml = results.map((r, i) => {
    const scoreColor = r.score >= 80 ? '#22c55e' : r.score >= 50 ? '#f59e0b' : '#ef4444'
    const status = r.status === 'error' ? '⛔ 오류' : '✅ 완료'
    const w3cCell = w3cChecked
      ? `<td style="padding:10px 12px;text-align:center;font-size:12px;">
          ${r.w3c?.checkedAt
            ? `<span style="color:${(r.w3c?.errorCount||0)>0?'#dc2626':'#16a34a'};font-weight:700">${r.w3c?.errorCount||0}</span><span style="color:#94a3b8;font-size:10px">/</span><span style="color:${r.w3c?.valid===false?'#dc2626':r.w3c?.valid===true?'#16a34a':'#64748b'};font-weight:600;font-size:11px">${r.w3c?.valid===true?'유효':r.w3c?.valid===false?'무효':'?'}</span>`
            : '<span style="color:#94a3b8">-</span>'}</td>`
      : ''
    return `
    <tr style="border-bottom:1px solid #e2e8f0;${i%2===0?'background:#fff':'background:#f8fafc'}">
      <td style="padding:10px 12px;font-size:12px;color:#64748b">${i+1}</td>
      <td style="padding:10px 12px;">
        <div style="font-size:13px;font-weight:600;color:#1e293b;margin-bottom:2px">${escapeHtml(r.pageTitle||'제목없음')}</div>
        <div style="font-size:11px;color:#94a3b8;word-break:break-all">${escapeHtml(r.url||r.originalUrl||'')}</div>
      </td>
      <td style="padding:10px 12px;text-align:center">
        <span style="font-size:20px;font-weight:800;color:${scoreColor}">${r.score !== undefined ? r.score : '-'}</span>
      </td>
      <td style="padding:10px 12px;text-align:center;color:#ef4444;font-weight:700">${r.summary?.violations || '-'}</td>
      <td style="padding:10px 12px;text-align:center;color:#7c3aed;font-weight:700">${r.spelling?.totalIssues ?? '-'}</td>
      <td style="padding:10px 12px;text-align:center;color:#dc2626;font-weight:700">${r.links?.dead?.length ?? '-'}</td>
      ${w3cCell}
      <td style="padding:10px 12px;text-align:center;font-size:12px">${status}</td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>배치 검사 종합 보고서 - ${escapeHtml(session.id)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Apple SD Gothic Neo','Malgun Gothic',Arial,sans-serif;background:#f8fafc;color:#1e293b}
  .header{background:linear-gradient(135deg,#1e3a5f 0%,#0d9488 100%);color:white;padding:36px 40px}
  .header h1{font-size:26px;font-weight:700;margin-bottom:6px}
  .meta{font-size:12px;opacity:.85;margin-top:3px}
  .container{max-width:1100px;margin:0 auto;padding:28px 20px}
  .section{background:white;border-radius:12px;padding:24px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  .section h2{font-size:17px;font-weight:700;margin-bottom:16px;color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:8px}
  table{width:100%;border-collapse:collapse}
  th{background:#1e293b;color:white;padding:10px 12px;font-size:12px;text-align:center}
  th:nth-child(2){text-align:left}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:24px}
  .kpi{padding:16px;border-radius:10px;text-align:center}
  .kpi-num{font-size:36px;font-weight:800}
  .kpi-lbl{font-size:11px;margin-top:4px;opacity:.8}
  .footer{text-align:center;color:#94a3b8;font-size:11px;margin-top:28px;padding-bottom:36px}
  @media print{body{background:white}.header{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="header">
  <div style="max-width:1100px;margin:0 auto">
    <h1>📋 배치 검사 종합 증적 보고서</h1>
    <div class="meta">🏛 대상: 정부24(www.gov.kr/mw) 민원안내 페이지</div>
    <div class="meta">📅 검사 일시: ${new Date(session.createdAt).toLocaleString('ko-KR')} ~ ${session.finishedAt ? new Date(session.finishedAt).toLocaleString('ko-KR') : '진행중'}</div>
    <div class="meta">🆔 세션 ID: ${escapeHtml(session.id)}</div>
    <div class="meta">📊 총 ${session.total}개 페이지 | 완료 ${session.completed}개 | 실패 ${session.failed}개</div>
  </div>
</div>
<div class="container">
  <div class="section">
    <h2>📊 종합 KPI</h2>
    <div class="kpi-grid">
      <div class="kpi" style="background:#eff6ff;color:#1d4ed8">
        <div class="kpi-num">${session.total}</div>
        <div class="kpi-lbl">검사 페이지 수</div>
      </div>
      <div class="kpi" style="background:${avgScore>=80?'#f0fdf4':avgScore>=50?'#fffbeb':'#fef2f2'};color:${avgScore>=80?'#16a34a':avgScore>=50?'#d97706':'#dc2626'}">
        <div class="kpi-num">${avgScore}</div>
        <div class="kpi-lbl">평균 접근성 점수</div>
      </div>
      <div class="kpi" style="background:#fef2f2;color:#dc2626">
        <div class="kpi-num">${totalViolations}</div>
        <div class="kpi-lbl">총 접근성 위반</div>
      </div>
      <div class="kpi" style="background:#faf5ff;color:#7c3aed">
        <div class="kpi-num">${totalSpelling}</div>
        <div class="kpi-lbl">총 오탈자</div>
      </div>
      <div class="kpi" style="background:#fef2f2;color:#dc2626">
        <div class="kpi-num">${totalDeadLinks}</div>
        <div class="kpi-lbl">총 데드링크</div>
      </div>
      ${w3cChecked ? `
      <div class="kpi" style="background:${w3cInvalidCount>0?'#fef2f2':'#f0fdf4'};color:${w3cInvalidCount>0?'#dc2626':'#16a34a'}">
        <div class="kpi-num">${totalW3cErrors}</div>
        <div class="kpi-lbl">W3C 오류 (${w3cInvalidCount}페이지 무효)</div>
      </div>` : ''}
    </div>
  </div>
  <div class="section">
    <h2>📄 페이지별 검사 결과</h2>
    <table>
      <thead>
        <tr>
          <th style="width:40px">#</th>
          <th style="text-align:left">페이지</th>
          <th style="width:80px">점수</th>
          <th style="width:70px">위반</th>
          <th style="width:70px">오탈자</th>
          <th style="width:80px">데드링크</th>
          ${w3cChecked ? '<th style="width:90px">W3C 오류/유효성</th>' : ''}
          <th style="width:70px">상태</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
  <div class="footer">
    <p>본 보고서는 가디언즈 오브 겔럭시 배치 자동 검사 증적입니다. (axe-core + Playwright)</p>
    <p>생성: ${new Date().toLocaleString('ko-KR')}</p>
  </div>
</div>
</body>
</html>`
}

// ─── 서버 시작 ───────────────────────────────────────
const PORT = 3000
createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 가디언즈 오브 겔럭시 서버 실행 중: http://0.0.0.0:${PORT}`)
  // 서버 시작 시 엑셀 미리 로드 (캐시 워밍업 + 경로 검증)
  loadMinwonByStep()
    .then(d => console.log(`📋 민원 목록 로드 완료: 1차=${d['1차'].length}, 2차=${d['2차'].length}, 3차=${d['3차'].length}`))
    .catch(e => console.error(`⚠️ 민원 목록 로드 실패 (API는 동작하나 검사 시작 불가): ${e.message}`))
})
