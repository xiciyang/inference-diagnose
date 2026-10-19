/**
 * rename-contract.spec —— P9 命名变更专项（2026-09-28）。
 *
 * 覆盖三件事，任何一件失败都说明"改名只改了一半"：
 *   ① 身份同步面：package.json / cordis.patch.yml / src 导出 name 三处一致
 *   ② 旧标识零残留：src/、tests/、包元数据里不得再出现改名前的包名与工具名（见 FORBIDDEN）
 *   ③ **真调 ctx.tools.register**：五个工具在"像 DSH 一样挑刺"的 mock ctx 下全部注册成功
 *      （判据来自实测教训：注入返回 host ✓ ≠ 工具注册成功；缺 output.render 会让整条 entry 被拒）
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { apply, name, createCore, SCHEMA_VERSION } from '../../src/index.js'

export const NAME = 'rename-contract（§1 定位：包名 / 工具名 / 同步面 / 五工具真实注册）'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const NEW_NAME = '@xiciyang/inference-diagnose'
// 断言文本本身不得包含旧标识（否则扫描会命中本文件自己）——用拼接构造模式
const FORBIDDEN = [['diagnose', 'crash'], ['dsh-llm', '-crash-diagnoser'], ['llm', '-crash-diagnoser']].map(
  (parts) => new RegExp(parts.join('')),
)

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

export async function run(t) {
  // ── ① 身份同步面 ──
  t.assert(name === NEW_NAME, `src/index.js 导出的 name = ${NEW_NAME}（实际 ${name}）`)
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
  t.assert(pkg.name === NEW_NAME, `package.json name = ${NEW_NAME}（实际 ${pkg.name}）`)
  const patch = readFileSync(join(PKG_ROOT, 'cordis.patch.yml'), 'utf8')
  t.assert(/^\s*-\s*id: inference-diagnose\s*$/m.test(patch), 'cordis.patch.yml entry id = inference-diagnose')
  t.assert(patch.includes(`name: '${NEW_NAME}'`), 'cordis.patch.yml name 引用新包名')
  t.assert(/inject:\s*\n\s*- tools/.test(patch), 'cordis.patch.yml inject: [tools] 未被改名破坏')
  t.assert(/inference-diagnose/.test(readFileSync(join(PKG_ROOT, 'README.md'), 'utf8')), 'README 标题已同步新包名')

  // ── ② 旧标识零残留 ──
  const files = [
    ...walk(join(PKG_ROOT, 'src')),
    ...walk(join(PKG_ROOT, 'tests')),
    join(PKG_ROOT, 'package.json'),
    join(PKG_ROOT, 'cordis.patch.yml'),
    join(PKG_ROOT, 'README.md'),
  ]
  const hits = []
  for (const f of files) {
    const txt = readFileSync(f, 'utf8')
    for (const re of FORBIDDEN) if (re.test(txt)) hits.push(`${f.replace(PKG_ROOT + '/', '')}:${re}`)
  }
  t.assert(hits.length === 0, `旧标识零残留（命中：${hits.slice(0, 3).join(' | ') || '无'}）`)

  // ── ③ 五工具真实注册（mock ctx 像 DSH 一样挑刺）──
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-rename-'))
  const prevHome = process.env.DSH_HOME
  const prevAuditRoot = process.env.INFERENCE_DIAGNOSE_ROOT
  process.env.DSH_HOME = tmp // 让 apply() 的默认存储目录落在临时目录，不碰真实 home
  // A3 之后 apply() 还会写审计；本 spec 不执行工具，但把审计根也钉到 tmp 上，
  // 保证"测试绝不碰真实 ~/.ai-infra"这条纪律不依赖"恰好没调用 execute"。
  process.env.INFERENCE_DIAGNOSE_ROOT = join(tmp, 'ai-infra')
  const registered = []
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const d = fn()
      disposers.push(d)
      return d
    },
    tools: {
      register(tool) {
        // 与 DSH loader 同款校验：output 必须同时给 schema 与 render
        if (!tool.output || !tool.output.schema || typeof tool.output.render !== 'function') {
          throw new Error(`tool "${tool.name}" must declare output { schema, render, presentationMeta? }`)
        }
        registered.push(tool)
        return () => {}
      },
    },
  }
  let applyThrew = null
  try {
    apply(ctx)
  } catch (e) {
    applyThrew = String(e.message)
  }
  t.assert(applyThrew === null, `apply() 未抛错（实际：${applyThrew}）`)

  const names = registered.map((x) => x.name)
  const expected = ['generate_collect_script', 'parse_collect_report', 'diagnose_service', 'diagnose_regression', 'diagnose_consistency']
  t.assert(
    JSON.stringify(names) === JSON.stringify(expected),
    `五个工具按序注册（实际 ${names.join(', ')}）`,
  )
  for (const tool of registered) {
    t.assert(typeof tool.description === 'string' && tool.description.length > 80, `${tool.name} 有可读 description`)
    t.assert(tool.parameters && tool.parameters.type === 'object', `${tool.name} 声明 object 参数`)
    t.assert(typeof tool.execute === 'function', `${tool.name} 有 execute`)
  }
  // 改名的语义边界：diagnose_service 的**参数结构与语义不变**（只改工具名与描述）
  const ds = registered.find((x) => x.name === 'diagnose_service')
  t.assert(JSON.stringify(ds.parameters.required) === JSON.stringify(['evidence', 'dimensions']), 'diagnose_service 必填参数仍为 evidence + dimensions')
  t.assert(!!ds.parameters.properties.context, 'diagnose_service 仍接受 context')
  t.assert(/service anomaly/i.test(ds.description), 'diagnose_service 描述已覆盖"服务异常"（不再只写 crash）')
  t.assert(/garbled/i.test(ds.description) && /truncated/i.test(ds.description), 'diagnose_service 描述涵盖输出异常（乱码/截断）')

  // 新工具的参数契约
  const dr = registered.find((x) => x.name === 'diagnose_regression')
  t.assert(JSON.stringify(dr.parameters.required) === JSON.stringify(['report', 'baselineType']), 'diagnose_regression 必填 report + baselineType')
  t.assert(!!dr.parameters.properties.baseline && !!dr.parameters.properties.sessionId, 'diagnose_regression 接受 baseline / sessionId')
  t.assert(JSON.stringify(dr.parameters.properties.baselineType.enum) === JSON.stringify(['performance', 'accuracy']), 'baselineType 是受控枚举')
  const dc = registered.find((x) => x.name === 'diagnose_consistency')
  t.assert(JSON.stringify(dc.parameters.required) === JSON.stringify(['report']), 'diagnose_consistency 必填 report')

  // ── ④ 默认存储目录随包名（不再与旧标识耦合）──
  const core = createCore({ pkgRoot: PKG_ROOT, storageDir: null, persist: true })
  const dir = String(core.tracker.storageDir() || '')
  t.assert(dir.includes('inference-diagnose'), `默认存储目录含新标识（实际 ${dir}）`)
  t.assert(!FORBIDDEN[2].test(dir), '默认存储目录不含旧标识')
  t.assert(SCHEMA_VERSION === '2', 'schema 版本未因改名而变（改名不是 schema 变更）')

  for (const d of disposers) {
    try {
      if (typeof d === 'function') d()
    } catch {
      /* disposer 失败不影响断言结论 */
    }
  }
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  if (prevAuditRoot === undefined) delete process.env.INFERENCE_DIAGNOSE_ROOT
  else process.env.INFERENCE_DIAGNOSE_ROOT = prevAuditRoot
  rmSync(tmp, { recursive: true, force: true })
}
