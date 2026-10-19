/**
 * script-composer —— §2.2 采集脚本组装（原 script-generator）。
 *
 * 输入：三维组合解析结果（探针集）+ 脱敏规则 + 模板
 * 输出：{ script, manifest }。脚本内嵌脱敏函数（bashShim），报告在用户服务器侧
 * 即已脱敏 —— 这是 §2.5 "全链路无明文落盘" 的第一道保证。
 *
 * 模板缺失属**第四个独立依赖源**：缺 → ERR_TEMPLATE_NOT_LOADED（REFUSE，fail-closed），
 * 不共用 ERR_INTERNAL（2026-09-18 用户裁决，闭集 7 → 8）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from './yaml-lite.js'
import { bashShim } from './desensitizer.js'
import { ToolError, ErrCode } from '../protocol/envelope.js'

const TEMPLATE_DIR = 'templates'

function pickTemplate(assetsRoot, combo) {
  const dir = join(assetsRoot, TEMPLATE_DIR)
  if (!existsSync(dir)) return { ok: false, reason: `缺少目录 ${TEMPLATE_DIR}/` }
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort()
  if (files.length === 0) return { ok: false, reason: `${TEMPLATE_DIR}/ 下没有模板文件` }
  const problems = []
  for (const f of files) {
    try {
      const doc = parse(readFileSync(join(dir, f), 'utf8'))
      if (!doc || typeof doc !== 'object' || typeof doc.template !== 'string' || doc.template.trim() === '') {
        problems.push(`${f}: 缺少非空 template`)
        continue
      }
      // 框架维度优先匹配模板文件名（collect-<framework>.yaml）；否则取第一个可用模板
      const preferred = `collect-${combo.dims.framework}.yaml`
      if (f === preferred) return { ok: true, id: doc.id || f, file: f, doc }
      if (!problems.__fallback) problems.__fallback = { ok: true, id: doc.id || f, file: f, doc }
    } catch (e) {
      problems.push(`${f}: ${String(e.message).slice(0, 80)}`)
    }
  }
  if (problems.__fallback) return problems.__fallback
  return { ok: false, reason: problems.join('；') || '没有可用模板' }
}

/**
 * @param {{assetsRoot:string, combo:object, description:string, ruleset:object, versions:object}} p
 */
export function compose({ assetsRoot, combo, description, ruleset, versions }) {
  const tpl = pickTemplate(assetsRoot, combo)
  if (!tpl.ok) {
    throw new ToolError(ErrCode.TEMPLATE_NOT_LOADED, {
      message: '采集模板不可用',
      affected: ['templates'],
      policy: 'REFUSE',
      recoverable: true,
      hint:
        `采集模板不可用：${tpl.reason}。无法组装采集脚本（fail-closed）。` +
        `请检查 assets/templates/ 下模板文件存在、为合法 YAML 且含非空 template。`,
    })
  }

  const probeBlocks = combo.probes
    .map((p) => `emit "${p.section}" '${p.command.replace(/'/g, "'\\''")}'`)
    .join('\n')

  const header =
    `generated-by=inference-diagnose plugin=${versions.plugin} schema=${versions.schema} ` +
    `rules=${versions.rules} assets=${versions.assets} dims=${combo.dims.framework}/${combo.dims.runtime}/${combo.dims.hardware} ` +
    `problem=${String(description).replace(/[\r\n]+/g, ' ').slice(0, 120)}`

  const script = tpl.doc.template
    .replace('{{HEADER}}', header)
    .replace('{{SHIM}}', bashShim(ruleset.rules))
    .replace('{{PROBE_BLOCKS}}', probeBlocks)

  const manifest = {
    templateId: tpl.id,
    templateFile: tpl.file,
    dims: combo.dims,
    sections: [...new Set(combo.probes.map((p) => p.section))],
    probes: combo.probes.map((p) => ({ probe: p.probe, section: p.section })),
    rules: versions.rules,
    assets: versions.assets,
    generatedAt: new Date().toISOString(),
  }
  return { script, manifest }
}
