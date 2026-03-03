import express from 'express'
import cors from 'cors'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.static(join(__dirname, 'public')))

// 영문 spell checker 미사용 (한국어 전용 오탈자 검사)

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

// ─── 한글 오탈자 검사 (규칙 기반) ────────────────────
function checkKoreanTypo(text) {
  const issues = []
  // 자주 틀리는 한글 패턴 (오타 → 올바른 표현)
  const koreanRules = [
    { pattern: /되여/g,    correct: '되어',     desc: '\'되어\'의 잘못된 표기' },
    { pattern: /됬/g,      correct: '됐',       desc: '\'됐\'의 잘못된 표기' },
    { pattern: /할께요/g,  correct: '할게요',   desc: '\'할게요\'의 잘못된 표기' },
    { pattern: /할께/g,    correct: '할게',     desc: '\'할게\'의 잘못된 표기' },
    { pattern: /안되/g,    correct: '안 돼',    desc: '\'안 돼\'의 잘못된 표기' },
    { pattern: /않돼/g,    correct: '안 돼',    desc: '\'안 돼\'의 잘못된 표기' },
    { pattern: /왠지/g,    correct: '왠지',     desc: '\'왠지\'는 \'왜인지\'의 준말로 올바른 표기 (참고용)' },
    { pattern: /웬만하면/g, correct: '웬만하면', desc: '\'웬만하면\' 표기 확인' },
    { pattern: /어떻해/g,  correct: '어떡해',   desc: '\'어떡해\'의 잘못된 표기' },
    { pattern: /어떻게해/g, correct: '어떡해',  desc: '\'어떡해\'의 잘못된 표기' },
    { pattern: /몇일/g,    correct: '며칠',     desc: '\'며칠\'의 잘못된 표기' },
    { pattern: /예기/g,    correct: '얘기',     desc: '\'얘기\'의 잘못된 표기' },
    { pattern: /로서[\s]/g, correct: '로써 ',   desc: '도구/수단에는 \'로써\' 사용 권장 (문맥 확인 필요)' },
    { pattern: /데로/g,    correct: '대로',     desc: '\'대로\'의 잘못된 표기' },
    { pattern: /거에요/g,  correct: '거예요',   desc: '\'거예요\'의 잘못된 표기' },
    { pattern: /이에요\./g, correct: '이에요.',  desc: '\'이에요\' 확인 (예요/이에요 구분)' },
    { pattern: /있슴/g,    correct: '있음',     desc: '\'있음\'의 잘못된 표기' },
    { pattern: /없슴/g,    correct: '없음',     desc: '\'없음\'의 잘못된 표기' },
    { pattern: /습니다\s+다/g, correct: '습니다', desc: '중복된 어미 표현' },
    { pattern: /\.\.\./g,  correct: '…',        desc: '말줄임표는 \'…\' 사용 권장' },
  ]
  for (const rule of koreanRules) {
    const matches = [...text.matchAll(rule.pattern)]
    for (const m of matches) {
      const idx = m.index
      const ctx = text.substring(Math.max(0, idx - 20), Math.min(text.length, idx + 30))
      issues.push({
        word: m[0].trim(),
        suggestion: rule.correct,
        context: ctx,
        desc: rule.desc,
        type: 'korean'
      })
    }
  }
  return issues
}

// 영문 오탈자 검사 제거 (한국어 전용)

// ─── 데드링크 검사 ────────────────────────────────────
async function checkDeadLinks(links, baseUrl, page) {
  const results = []
  const checked = new Map()
  // 동일 도메인 우선, 외부 링크는 최대 30개로 제한
  const baseDomain = new URL(baseUrl).hostname
  const internalLinks = links.filter(l => { try { return new URL(l).hostname === baseDomain } catch { return false } })
  const externalLinks = links.filter(l => { try { return new URL(l).hostname !== baseDomain } catch { return false } }).slice(0, 30)
  const allLinks = [...new Set([...internalLinks, ...externalLinks])].slice(0, 60)

  for (const link of allLinks) {
    if (checked.has(link)) continue
    checked.set(link, true)
    let status = null
    let ok = false
    let redirectUrl = null
    let error = null
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const resp = await fetch(link, {
        method: 'HEAD',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (A11y-Inspector/1.0)' }
      })
      clearTimeout(timer)
      status = resp.status
      ok = resp.ok || resp.status === 301 || resp.status === 302 || resp.status === 307 || resp.status === 308
      if (resp.url !== link) redirectUrl = resp.url
      // HEAD가 405이면 GET 재시도
      if (resp.status === 405) {
        const ctrl2 = new AbortController()
        const timer2 = setTimeout(() => ctrl2.abort(), 8000)
        const resp2 = await fetch(link, { method: 'GET', redirect: 'follow', signal: ctrl2.signal, headers: { 'User-Agent': 'Mozilla/5.0 (A11y-Inspector/1.0)' } })
        clearTimeout(timer2)
        status = resp2.status
        ok = resp2.ok
      }
    } catch (e) {
      error = e.name === 'AbortError' ? '연결 시간 초과' : e.message.includes('fetch') ? '연결 실패' : e.message.substring(0, 60)
      ok = false
    }
    if (!ok) {
      results.push({ url: link, status, error, redirectUrl, ok: false })
    } else {
      results.push({ url: link, status, redirectUrl, ok: true })
    }
  }
  return { results, total: allLinks.length }
}

// ═══════════════════════════════════════════════════════
// ─── 메인 통합 검사 API ───────────────────────────────
// ═══════════════════════════════════════════════════════
app.post('/api/scan', async (req, res) => {
  const {
    url,
    level = 'wcag2aa',
    includeScreenshot = true,
    checkSpelling = true,
    checkLinks = true
  } = req.body

  if (!url) return res.status(400).json({ error: 'URL이 필요합니다.' })

  let normalizedUrl = url
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = 'https://' + normalizedUrl
  }

  let browser
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1500)

    const pageTitle = await page.title()
    const pageUrl = page.url()

    // ── 스크린샷 ──────────────────────────────────────
    let screenshotBase64 = null
    if (includeScreenshot) {
      const buf = await page.screenshot({ fullPage: false, type: 'png' })
      screenshotBase64 = buf.toString('base64')
    }

    // ── 접근성 검사 (axe-core) ────────────────────────
    const axeSource = readFileSync(join(__dirname, 'node_modules/axe-core/axe.min.js'), 'utf8')
    await page.addScriptTag({ content: axeSource })
    const axeResults = await page.evaluate(async (runLevel) => {
      return await window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: runLevel === 'wcag2a' ? ['wcag2a'] :
                  runLevel === 'wcag2aa' ? ['wcag2a', 'wcag2aa'] :
                  ['wcag2a', 'wcag2aa', 'wcag2aaa']
        }
      })
    }, level)

    const violations = axeResults.violations.map(v => ({
      id: v.id, impact: v.impact, description: v.description,
      help: v.help, helpUrl: v.helpUrl, tags: v.tags,
      nodes: v.nodes.map(n => ({ html: n.html, failureSummary: n.failureSummary, target: n.target }))
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

    // ── 오탈자 검사 ───────────────────────────────────
    let spellingResult = { issues: [], totalWords: 0, checkedAt: new Date().toISOString() }
    if (checkSpelling) {
      // 페이지에서 텍스트와 링크 텍스트 추출
      const pageText = await page.evaluate(() => {
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
        return texts.join(' ')
      })

      const koIssues = checkKoreanTypo(pageText)
      const wordCount = pageText.split(/\s+/).filter(w => w.length > 0).length

      spellingResult = {
        issues: koIssues.slice(0, 50), // 최대 50개
        totalWords: wordCount,
        totalIssues: koIssues.length,
        koreanIssues: koIssues.length,
        checkedAt: new Date().toISOString()
      }
    }

    // ── 데드링크 검사 ─────────────────────────────────
    let linkResult = { dead: [], redirects: [], live: 0, total: 0, checkedAt: new Date().toISOString() }
    if (checkLinks) {
      // 모든 링크 수집
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
        dead,
        redirects,
        live,
        total,
        totalRaw: rawLinks.length,
        checkedAt: new Date().toISOString()
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
      summary: { violations: violations.length, passes, incomplete, inapplicable, impactCounts },
      violations,
      screenshot: screenshotBase64,
      spelling: spellingResult,
      links: linkResult
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
  const spellingHtml = (sp.issues && sp.issues.length > 0) ? sp.issues.map((issue, i) => `
    <div style="border-left:4px solid ${issue.type==='korean'?'#8b5cf6':'#0891b2'};margin-bottom:12px;padding:10px 14px;background:#fafafa;border-radius:0 6px 6px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <strong style="font-size:13px;color:#1e293b;">"${escapeHtml(issue.word)}"</strong>
        <span style="background:${issue.type==='korean'?'#8b5cf6':'#0891b2'};color:white;padding:1px 8px;border-radius:10px;font-size:10px;">${issue.type==='korean'?'한글':'영문'}</span>
      </div>
      <div style="font-size:12px;color:#475569;margin-bottom:4px;">✏️ 제안: <strong style="color:#059669;">${escapeHtml(issue.suggestion)}</strong></div>
      ${issue.desc?`<div style="font-size:11px;color:#64748b;margin-bottom:4px;">${escapeHtml(issue.desc)}</div>`:''}
      ${issue.context?`<div style="font-family:monospace;font-size:11px;background:#e2e8f0;padding:3px 8px;border-radius:4px;color:#475569;">"...${escapeHtml(issue.context)}..."</div>`:''}
    </div>`).join('') : '<div style="text-align:center;padding:24px;color:#22c55e;font-weight:600;">✅ 오탈자가 감지되지 않았습니다.</div>'

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

  <div class="footer">
    <p>본 보고서는 A11y Inspector 자동 검사 결과입니다. (axe-core + Playwright)</p>
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

// ─── 서버 시작 ───────────────────────────────────────
const PORT = 3000
createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ A11y Inspector 서버 실행 중: http://0.0.0.0:${PORT}`)
})
