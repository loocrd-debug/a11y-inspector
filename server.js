import express from 'express'
import cors from 'cors'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import ExcelJS from 'exceljs'

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

// ═══════════════════════════════════════════════════════
// ─── 민원안내 페이지 목록 조회 API ───────────────────
// ═══════════════════════════════════════════════════════

// 인메모리 저장소 (배치 스캔 세션 및 결과)
const batchSessions = new Map()
const evidenceStore = new Map()

// 민원 목록 조회 (plus.gov.kr API 활용 → www.gov.kr/mw 민원안내 URL 사용)
app.get('/api/minwon/list', async (req, res) => {
  const { page = 1, pageSize = 20, query = '' } = req.query
  const ps = Math.min(parseInt(pageSize) || 20, 1000)  // 최대 1000개 허용
  // GOV24_URL 기준으로 중복이 많으므로 실제 표시할 수보다 더 많이 가져옴
  // pageSize=1000일 때 충분히 수집하기 위해 최대 6000까지 허용
  const fetchSize = Math.min(ps * 6, 6000)
  const startCount = (parseInt(page) - 1) * ps

  try {
    const response = await fetch('https://plus.gov.kr/api/iwcas/guide/v1.0/search/mergeResult', {
      method: 'POST',
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

    const data = await response.json()
    const mergeResult = data.searchMergeResult?.MERGE_COLLECTION || []
    const totalCount = data.totalCount || 0

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
// ─── 배치 스캔 API ────────────────────────────────────
// ═══════════════════════════════════════════════════════

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

// 단일 페이지 스캔 (배치용 내부 함수)
async function scanSinglePage(url, options = {}) {
  const {
    level = 'wcag2aa',
    includeScreenshot = true,
    checkSpelling = true,
    checkLinks = false,
    checkW3C = false
  } = options
  
  let browser
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1500)

    const pageTitle = await page.title()
    const pageUrl = page.url()

    // 스크린샷
    let screenshotBase64 = null
    if (includeScreenshot) {
      const buf = await page.screenshot({ fullPage: false, type: 'png' })
      screenshotBase64 = buf.toString('base64')
    }

    // 접근성 검사
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

    // 오탈자 검사
    let spellingResult = { issues: [], totalWords: 0, checkedAt: new Date().toISOString() }
    if (checkSpelling) {
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
        issues: koIssues.slice(0, 50),
        totalWords: wordCount,
        totalIssues: koIssues.length,
        koreanIssues: koIssues.length,
        checkedAt: new Date().toISOString()
      }
    }

    // 데드링크 검사 (배치에서는 기본 비활성화로 속도 향상)
    let linkResult = { dead: [], redirects: [], live: 0, total: 0, checkedAt: new Date().toISOString() }
    if (checkLinks) {
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
      linkResult = { dead, redirects, live, total, totalRaw: rawLinks.length, checkedAt: new Date().toISOString() }
    }

    // ── W3C Markup Validation ──────────────────────────
    let w3cResult = { valid: null, errorCount: 0, warningCount: 0, fatalCount: 0, errors: [], warnings: [] }
    if (checkW3C) {
      // 렌더링된 HTML 소스 추출 (DOCTYPE 포함)
      const htmlSource = await page.content()
      w3cResult = await validateW3C(htmlSource, pageUrl)
    }

    await browser.close()

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
      status: 'completed'
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {})
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
      status: 'error',
      error: err.message
    }
  }
}

// 배치 스캔 시작
app.post('/api/batch/start', async (req, res) => {
  const { urls, options = {} } = req.body
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls 배열이 필요합니다.' })
  }
  if (urls.length > 1000) {
    return res.status(400).json({ error: '최대 1000개 URL까지 배치 스캔 가능합니다.' })
  }

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
    urls
  }
  batchSessions.set(sessionId, session)

  res.json({ sessionId, total: urls.length, message: '배치 스캔이 시작되었습니다.' })

  // 백그라운드 실행 (순차 처리)
  ;(async () => {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      try {
        const result = await scanSinglePage(url, options)
        session.results.push(result)
        // 증적 개별 저장
        evidenceStore.set(result.id, result)
        if (result.status === 'error') session.failed++
        else session.completed++
      } catch (err) {
        session.failed++
        session.results.push({ url, status: 'error', error: err.message })
      }
      session.progress = Math.round((i + 1) / urls.length * 100)
    }
    session.status = 'completed'
    session.finishedAt = new Date().toISOString()
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

      // 각 세션을 백그라운드에서 순차 처리
      ;(async (sess, urlList) => {
        for (let j = 0; j < urlList.length; j++) {
          const entry = urlList[j]
          const urlStr = typeof entry === 'string' ? entry : entry.url
          try {
            const result = await scanSinglePage(urlStr, options)
            // 메타정보 보강
            if (typeof entry === 'object') {
              result.category = result.category || entry.category
              result.department = result.department || entry.department
            }
            sess.results.push(result)
            evidenceStore.set(result.id, result)
            if (result.status === 'error') sess.failed++
            else sess.completed++
          } catch (err) {
            sess.failed++
            sess.results.push({ url: urlStr, status: 'error', error: err.message })
          }
          sess.progress = Math.round((j + 1) / urlList.length * 100)
        }
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
  res.json({
    id: session.id,
    status: session.status,
    total: session.total,
    completed: session.completed,
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
    wb.creator = 'A11y Inspector'
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
  const spellingHtml = (sp.issues && sp.issues.length > 0) ? sp.issues.map((issue, i) => `
    <div style="border-left:4px solid #8b5cf6;margin-bottom:12px;padding:10px 14px;background:#fafafa;border-radius:0 6px 6px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <strong style="font-size:13px;color:#1e293b;">"${escapeHtml(issue.word)}"</strong>
        <span style="background:#8b5cf6;color:white;padding:1px 8px;border-radius:10px;font-size:10px;">한글</span>
      </div>
      <div style="font-size:12px;color:#475569;margin-bottom:4px;">✏️ 제안: <strong style="color:#059669;">${escapeHtml(issue.suggestion)}</strong></div>
      ${issue.desc?`<div style="font-size:11px;color:#64748b;margin-bottom:4px;">${escapeHtml(issue.desc)}</div>`:''}
      ${issue.context?`<div style="font-family:monospace;font-size:11px;background:#e2e8f0;padding:3px 8px;border-radius:4px;color:#475569;">"...${escapeHtml(issue.context)}..."</div>`:''}
    </div>`).join('') : '<div style="text-align:center;padding:24px;color:#22c55e;font-weight:600;">✅ 오탈자가 감지되지 않았습니다.</div>'

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
    <p>본 보고서는 A11y Inspector 자동 검사 증적입니다. (axe-core + Playwright)</p>
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
    <p>본 보고서는 A11y Inspector 배치 자동 검사 증적입니다. (axe-core + Playwright)</p>
    <p>생성: ${new Date().toLocaleString('ko-KR')}</p>
  </div>
</div>
</body>
</html>`
}

// ─── 서버 시작 ───────────────────────────────────────
const PORT = 3000
createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ A11y Inspector 서버 실행 중: http://0.0.0.0:${PORT}`)
})
