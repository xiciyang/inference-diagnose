/**
 * yaml-lite —— L2 原子原语：YAML 子集解析器（零依赖，确定性）。
 *
 * 为什么自研而不是引 js-yaml：
 *   本机无 DSH 源码 checkout，插件以纯 JS 注入运行；引入外部依赖会带来
 *   profile 侧解析不确定（bundle 不随带 node_modules）。资产是"现场可扩展的
 *   数据文件"，解析器必须是包内确定行为。
 *
 * 支持的子集（资产与该子集一一对应，超出即报错而非静默猜）：
 *   - 注释            # 行注释（引号内的 # 不视为注释；块标量正文内不剥注释）
 *   - 映射            key: value / 嵌套（缩进）
 *   - 序列            - item / - key: value（序列内映射）
 *   - 标量            字符串（裸 / '单引号' / "双引号"）、数字、true/false、null/~
 *   - 流式集合        [a, b] / {k: v, k2: v2}（支持嵌套）
 *   - 块标量          | | - | + 与 >（保留换行 / 折叠；内容按首行缩进去缩进）
 * 不支持（遇到即抛 YamlParseError，不静默降级）：锚点 &、别名 *、标签 !!、
 * 多文档 ---、复杂键 ?、行首制表符。
 *
 * 关键实现约束：**块标量正文不是结构行** —— 正文里出现 `2>&1`、`# 注释` 这类
 * 内容时必须原样保留，既不做 unsupported 检查，也不剥注释（2026-09-18 实测踩到）。
 */
export class YamlParseError extends Error {
  constructor(msg, line) {
    super(`yaml-lite: ${msg}${line ? ` (line ${line})` : ''}`)
    this.name = 'YamlParseError'
    this.line = line
  }
}

/** 只在"值位置"判定不支持特性，避免误伤块标量正文与命令文本。 */
const UNSUPPORTED_VALUE = [
  [/:\s+&\S/, '锚点 (&)'],
  [/:\s+\*\S/, '别名 (*)'],
  [/:\s+!!/, '标签 (!!)'],
  [/[[{,]\s*[&*]\S/, '流式集合内的锚点/别名'],
]
const UNSUPPORTED_LINE = [[/^\t/, '行首制表符缩进']]

function blockRange(raw, keyRawNo, parentIndent) {
  let end = keyRawNo + 1
  let contentIndent = null
  while (end < raw.length) {
    const line = raw[end]
    if (line.trim() === '') {
      end += 1
      continue
    }
    const ind = indentOf(line)
    if (contentIndent === null) {
      if (ind <= parentIndent) break
      contentIndent = ind
    } else if (ind <= parentIndent) break
    end += 1
  }
  return { start: keyRawNo + 1, end, contentIndent }
}

export function parse(text) {
  if (typeof text !== 'string') throw new YamlParseError('input must be a string')
  const raw = text.split(/\r?\n/)

  // ---- 预扫描：构建结构行表，同时记录块标量范围（正文不入结构行表） ----
  const items = []
  const blockUntil = new Map()
  let skipped = -1
  for (let i = 0; i < raw.length; i++) {
    if (i < skipped) continue
    const line = raw[i]
    for (const [re, what] of UNSUPPORTED_LINE) {
      if (re.test(line)) throw new YamlParseError(`不支持的特性：${what}`, i + 1)
    }
    const stripped = stripComment(line)
    const body = stripped.trim()
    if (body === '') continue
    if (items.length === 0 && /^---\s*$/.test(body)) throw new YamlParseError('不支持多文档 (---)', i + 1)
    for (const [re, what] of UNSUPPORTED_VALUE) {
      if (re.test(body)) throw new YamlParseError(`不支持的特性：${what}`, i + 1)
    }
    const indent = indentOf(stripped)
    items.push({ indent, text: body, no: i })
    const kv = matchKey(body)
    const inlineVal = kv ? kv.value : body.startsWith('- ') ? body.slice(2).trim() : ''
    if (/^[|>][+-]?$/.test(inlineVal)) {
      const r = blockRange(raw, i, indent)
      blockUntil.set(i, r)
      skipped = r.end
    }
  }
  if (items.length === 0) return null

  let cursor = 0
  const isSeqItem = (t) => t === '-' || t.startsWith('- ')

  function parseBlock(indent) {
    if (cursor >= items.length || items[cursor].indent < indent) return null
    return isSeqItem(items[cursor].text) ? parseSeq(indent) : parseMap(indent)
  }

  function parseSeq(indent) {
    const arr = []
    while (cursor < items.length && items[cursor].indent === indent && isSeqItem(items[cursor].text)) {
      const it = items[cursor]
      const rest = it.text === '-' ? '' : it.text.slice(2).trim()
      if (rest === '') {
        cursor += 1
        arr.push(parseBlock(indent + 1))
        continue
      }
      // 序列项若是流式集合（- {..} / - [..]），必须整体当标量解析，不能当块映射的键
      // （2026-09-18 实测缺陷：`- { guard: ... }` 曾被解析成键 "{ guard"）
      if (rest.startsWith('{') || rest.startsWith('[')) {
        arr.push(scalar(rest, it.no + 1))
        cursor += 1
        continue
      }
      const kv = matchKey(rest)
      if (kv) {
        const obj = {}
        cursor += 1
        assign(obj, kv.key, valueOrBlock(kv.value, it.no, indent + 2))
        while (cursor < items.length && items[cursor].indent === indent + 2 && !isSeqItem(items[cursor].text)) {
          const k2 = matchKey(items[cursor].text)
          if (!k2) throw new YamlParseError('expected key: value', items[cursor].no + 1)
          const kNo = items[cursor].no
          cursor += 1
          assign(obj, k2.key, valueOrBlock(k2.value, kNo, indent + 2))
        }
        arr.push(obj)
        continue
      }
      arr.push(scalar(rest, it.no + 1))
      cursor += 1
    }
    return arr
  }

  function parseMap(indent) {
    const obj = {}
    while (cursor < items.length && items[cursor].indent === indent && !isSeqItem(items[cursor].text)) {
      const kv = matchKey(items[cursor].text)
      if (!kv) throw new YamlParseError('expected key: value', items[cursor].no + 1)
      const keyNo = items[cursor].no
      cursor += 1
      assign(obj, kv.key, valueOrBlock(kv.value, keyNo, indent))
    }
    return obj
  }

  function valueOrBlock(inline, keyRawNo, parentIndent) {
    if (inline !== '') {
      if (/^[|>][+-]?$/.test(inline)) return blockScalar(keyRawNo, parentIndent, inline)
      return scalar(inline, keyRawNo + 1)
    }
    if (cursor < items.length && items[cursor].indent > parentIndent) {
      return parseBlock(items[cursor].indent)
    }
    return null
  }

  function blockScalar(keyRawNo, parentIndent, header) {
    const folded = header[0] === '>'
    const chomp = header[1] === '-' ? 'strip' : header[1] === '+' ? 'keep' : 'clip'
    const pre = blockUntil.get(keyRawNo) || blockRange(raw, keyRawNo, parentIndent)
    const body = raw
      .slice(pre.start, pre.end)
      .map((l) => (l.trim() === '' ? '' : l.slice(pre.contentIndent ?? 0)))
    while (cursor < items.length && items[cursor].no < pre.end) cursor += 1
    let value = folded
      ? body.map((l) => (l === '' ? '\n' : l)).join(' ').replace(/ \n /g, '\n')
      : body.join('\n')
    value = chomp === 'strip' ? value.replace(/\n+$/, '') : value.replace(/\n*$/, '\n')
    return value
  }

  const out = parseBlock(items[0].indent)
  if (cursor !== items.length) throw new YamlParseError('trailing content', items[cursor].no + 1)
  return out
}

function stripComment(line) {
  let out = ''
  let q = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      out += c
      if (c === q) q = null
      continue
    }
    if (c === '"' || c === "'") {
      q = c
      out += c
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break
    out += c
  }
  return out.replace(/\s+$/, '')
}

function indentOf(line) {
  const m = line.match(/^ */)
  return m ? m[0].length : 0
}

function matchKey(text) {
  const m = text.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:\s][^:]*?):(?:\s+(.*))?$/)
  if (!m) return null
  return { key: unquote(m[1].trim()), value: (m[2] || '').trim() }
}

function assign(obj, key, val) {
  if (Object.prototype.hasOwnProperty.call(obj, key)) throw new YamlParseError(`duplicate key: ${key}`)
  obj[key] = val
}

function scalar(text, lineNo) {
  const t = text.trim()
  if (t === '' || t === '~' || t === 'null') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+$/.test(t)) return Number(t)
  if (/^-?\d*\.\d+$/.test(t)) return Number(t)
  if (t.startsWith('[') || t.startsWith('{')) return parseFlow(t, lineNo)
  return unquote(t)
}

function unquote(t) {
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

function parseFlow(text, lineNo) {
  let p = 0
  const s = text
  const ws = () => {
    while (p < s.length && /\s/.test(s[p])) p++
  }
  function value() {
    ws()
    if (s[p] === '[') return list()
    if (s[p] === '{') return map()
    if (s[p] === '"' || s[p] === "'") return str()
    const start = p
    while (p < s.length && !/[,\]}:]/.test(s[p])) p++
    return scalar(s.slice(start, p).trim(), lineNo)
  }
  function str() {
    const q = s[p]
    p++
    let out = ''
    while (p < s.length) {
      if (s[p] === '\\' && q === '"') {
        out += s[p + 1]
        p += 2
        continue
      }
      if (s[p] === q) {
        p++
        return out
      }
      out += s[p]
      p++
    }
    throw new YamlParseError('unterminated string in flow collection', lineNo)
  }
  function list() {
    p++
    const out = []
    ws()
    if (s[p] === ']') {
      p++
      return out
    }
    for (;;) {
      out.push(value())
      ws()
      if (s[p] === ',') {
        p++
        continue
      }
      if (s[p] === ']') {
        p++
        return out
      }
      throw new YamlParseError('malformed flow sequence', lineNo)
    }
  }
  function map() {
    p++
    const out = {}
    ws()
    if (s[p] === '}') {
      p++
      return out
    }
    for (;;) {
      ws()
      let k
      if (s[p] === '"' || s[p] === "'") k = str()
      else {
        const start = p
        while (p < s.length && !/[:\},\[]/.test(s[p])) p++
        k = s.slice(start, p).trim()
      }
      ws()
      if (s[p] !== ':') throw new YamlParseError('malformed flow mapping', lineNo)
      p++
      const v = value()
      assign(out, k, v)
      ws()
      if (s[p] === ',') {
        p++
        continue
      }
      if (s[p] === '}') {
        p++
        return out
      }
      throw new YamlParseError('malformed flow mapping', lineNo)
    }
  }
  const v = value()
  ws()
  if (p !== s.length) throw new YamlParseError('trailing characters in flow collection', lineNo)
  return v
}
