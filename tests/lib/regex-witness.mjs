/**
 * regex-witness —— 规则正则的「见证串」工具（仅门禁使用，不是运行时依赖）。
 *
 * 用途（C12 修订版变体）：为 `when` 的每个**顶层分支**合成一条能命中它的规范见证串 `W(B)`，
 * 用来判定该分支是否"可分离"：
 *   - `W(B)` 命中且**只命中** B ⇒ 该分支可分离 ⇒ 必须有**独占示例**，否则门禁 FAIL；
 *   - `W(B)` 同时命中别的分支 ⇒ 结构性重叠（如 `VLLM_USE_V1 ⊂ use_v1`）⇒ 必须显式登记，
 *     不允许静默通过（白名单空集是本仓的目标形态）。
 *
 * 合成器只覆盖本仓规则用到的子集：字面量 / `\s \d \w \n \t \b` / 字符类（含 `[^...]`）/
 * 分组（含非捕获与前瞻，按第一分支展开）/ 量词（`? * + {n,m}`，取最小可行次数）/ `.`。
 * 合不出来时返回空串，调用方按"合成失败"处理（计数并列出，不静默）。
 */
/** 极简正则->见证串合成器：只覆盖本仓规则用到的子集（字面量 / \s \d \w / 字符类 / 分组 / 量词 / . ）*/
export function synthesize(pat) {
  let i = 0
  const S = String(pat)
  const peek = () => S[i]
  function parseSeq(stopAtParen) {
    let out = ''
    while (i < S.length) {
      const c = S[i]
      if (stopAtParen && c === ')') break
      if (c === '|') break
      i++
      let piece = ''
      if (c === '\\') {
        const n = S[i++]
        piece = n === 's' ? ' ' : n === 'd' ? '1' : n === 'w' ? 'a' : n === 'n' ? ' ' : n === 't' ? ' ' : n === 'b' ? '' : n
      } else if (c === '[') {
        let cls = ''
        while (i < S.length && S[i] !== ']') {
          if (S[i] === '\\') { i++; cls += S[i] }
          else cls += S[i]
          i++
        }
        i++ // ]
        const neg = cls.startsWith('^')
        const body = neg ? cls.slice(1) : cls
        if (neg) piece = /[a-zA-Z0-9_]/.test(body) ? '-' : 'x'
        else piece = body.replace(/^\-/, '').replace(/\-/g, '').charAt(0) || 'x'
      } else if (c === '(') {
        // 非捕获/捕获/前瞻：先取第一个分支
        const save = i
        let depth = 1
        let j = i
        while (j < S.length && depth > 0) { if (S[j] === '\\') j++; else if (S[j] === '(') depth++; else if (S[j] === ')') depth--; j++ }
        const inner = S.slice(i, j - 1)
        i = j
        if (inner.startsWith('?!') || inner.startsWith('?=') || inner.startsWith('?<')) { piece = ''; void save }
        else piece = synthesize(inner.split('|')[0])
      } else if (c === '.') { piece = 'x' } else if (c === '^' || c === '$') { piece = '' } else { piece = c }
      // 量词
      let q = ''
      if (peek() === '?' || peek() === '*' || peek() === '+' || peek() === '{') {
        if (peek() === '{') { let k = i; while (k < S.length && S[k] !== '}') k++; q = S.slice(i + 1, k); i = k + 1 } else { q = S[i]; i++ }
        if (S[i] === '?') i++ // 惰性
        if (S[i] === '+') i++ // 占有
      }
      if (q === '?' || q === '*') piece = ''
      else if (q === '+' || q === '') { /* 保持 1 次 */ }
      else { const m = /^(\d+)(?:,(\d*))?$/.exec(q); if (m) piece = piece.repeat(Math.max(1, Math.min(Number(m[1]) || 1, 8))) }
      out += piece
    }
    return out
  }
  const first = S.split('|')[0]
  i = 0
  return parseSeq(false) || synthesize(first)
}

export function splitTopAlternatives(pat) {
  const out = []; let cur = '', depth = 0, inClass = false, esc = false
  for (const ch of String(pat)) {
    if (esc) { cur += ch; esc = false; continue }
    if (ch === '\\') { cur += ch; esc = true; continue }
    if (inClass) { cur += ch; if (ch === ']') inClass = false; continue }
    if (ch === '[') { cur += ch; inClass = true; continue }
    if (ch === '(') { cur += ch; depth += 1; continue }
    if (ch === ')') { cur += ch; depth = Math.max(0, depth - 1); continue }
    if (ch === '|' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}
