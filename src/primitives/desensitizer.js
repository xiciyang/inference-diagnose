/**
 * desensitizer —— §2.1/§2.3 脱敏规则执行（执行固定，规则数据可热变）。
 *
 * 两个使用面：
 *   ① 生成采集脚本时：把规则编译成 bash 函数（shim），内嵌进脚本 —— 报告在
 *      用户服务器侧就已脱敏，明文从不落盘（§2.5 不变量）。
 *   ② 解析报告时：对粘贴回来的内容做二次校验（§2.3），命中即 REFUSE（仅内存）。
 *
 * 规则缺失/非法 = 硬依赖缺失 → ERR_DESENSITIZE_RULES_NOT_LOADED（REFUSE）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from './yaml-lite.js'
import { ToolError, ErrCode } from '../protocol/envelope.js'

const RULES_DIR = 'rules'

/** 读取 assets/rules/*.yaml 中的规则集（全量合并，按文件名字典序保证确定性）。 */
export function loadRules(assetsRoot) {
  const dir = join(assetsRoot, RULES_DIR)
  if (!existsSync(dir)) return rulesUnavailable(`缺少目录 ${RULES_DIR}/`)
  let files
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort()
  } catch (e) {
    return rulesUnavailable(`无法列出 ${RULES_DIR}/：${String(e.message).slice(0, 80)}`)
  }
  if (files.length === 0) return rulesUnavailable(`${RULES_DIR}/ 下没有规则文件`)

  const compiled = []
  const ids = []
  const problems = []
  for (const f of files) {
    try {
      const doc = parse(readFileSync(join(dir, f), 'utf8'))
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rules)) {
        problems.push(`${f}: 缺少 rules 列表`)
        continue
      }
      ids.push(doc.id || f)
      for (const r of doc.rules) {
        if (!r || !r.field || !r.pattern) {
          problems.push(`${f}: 规则缺少 field/pattern`)
          continue
        }
        let re
        try {
          re = new RegExp(r.pattern, 'g')
        } catch (e) {
          problems.push(`${f}: 正则非法 (${r.field}): ${String(e.message).slice(0, 60)}`)
          continue
        }
        compiled.push({
          field: r.field,
          label: r.label || r.field,
          pattern: r.pattern,
          replacement: r.replacement == null ? '<REDACTED>' : String(r.replacement),
          re,
        })
      }
    } catch (e) {
      problems.push(`${f}: 解析失败 ${String(e.message).slice(0, 80)}`)
    }
  }
  if (problems.length > 0) return rulesUnavailable(problems.join('；'))
  if (compiled.length === 0) return rulesUnavailable('规则集为空（没有任何可用规则）')
  return { ok: true, id: ids.join('+'), rules: compiled, files: files.map((f) => `${RULES_DIR}/${f}`) }
}

function rulesUnavailable(reason) {
  return {
    ok: false,
    error: new ToolError(ErrCode.DESENSITIZE_RULES_NOT_LOADED, {
      affected: ['desensitize'],
      policy: 'REFUSE',
      recoverable: true,
      hint:
        `脱敏规则不可用：${reason}。拒绝在无脱敏规则时继续（fail-closed）——` +
        `生成脚本会产出明文报告，解析会失去二次校验闸门。请检查 assets/rules/ 下的数据文件。`,
    }),
  }
}

/** 按规则脱敏文本（JS 侧）。用函数式替换，避免 replacement 里的 $ 被当反向引用。 */
export function applyRules(rules, text) {
  let out = String(text)
  for (const r of rules) out = out.replace(r.re, () => r.replacement)
  return out
}

/**
 * 二次脱敏校验：命中即返回命中片段（已打码）。
 * 返回的 maskedSnippet 恒为打码片段 —— 原始内容不出现在任何返回值里。
 */
export function scan(rules, text) {
  const hits = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const r of rules) {
      r.re.lastIndex = 0
      let m
      while ((m = r.re.exec(lines[i])) !== null) {
        hits.push({ field: r.field, line: i + 1, maskedSnippet: mask(m[0]) })
        if (m.index === r.re.lastIndex) r.re.lastIndex += 1
        if (hits.length >= 200) return hits
      }
    }
  }
  return hits
}

/** 打码：保留首尾各 2 字符，中间以 *** 代替（短串整体打码）。 */
export function mask(s) {
  const t = String(s)
  if (t.length <= 4) return '*'.repeat(t.length)
  return `${t.slice(0, 2)}***${t.slice(-2)}`
}

/**
 * 把规则编译成 bash 脱敏函数（内嵌进采集脚本）。
 * 用 sed -E，replacement 为字面量 —— 与 JS 侧 applyRules 语义一致（不使用反向引用）。
 */
export function bashShim(rules, fnName = 'dsh_desensitize') {
  const lines = [
    `# 脱敏规则（生成时内嵌，版本随脚本固定）`,
    `${fnName}() {`,
    `  sed -E \\`,
  ]
  rules.forEach((r, idx) => {
    const esc = r.pattern.replace(/#/g, '\\#')
    const tail = idx === rules.length - 1 ? `    -e 's#${esc}#${r.replacement}#g'` : `    -e 's#${esc}#${r.replacement}#g' \\`
    lines.push(tail)
  })
  lines.push(`}`)
  return lines.join('\n')
}

export function rulesVersion(ruleset) {
  return ruleset && ruleset.id ? ruleset.id : 'unknown'
}
