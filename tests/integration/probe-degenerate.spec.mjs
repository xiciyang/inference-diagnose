/**
 * probe-degenerate.spec —— **探针层**退化路径（真实执行 L1 里的 shell 命令）。
 *
 * 为什么需要它：`degenerate-inputs.spec` 覆盖的是"报告→分析"这一半；而 #37/#38 那两个缺陷
 * 发生在**另一半**——探针自己在端点失败时产出了编造信号。只测分析侧，探针改错了也发现不了。
 *
 * 做法：把 `assets/dimensions/framework/*.yaml` 里的 `command` 取出来**真跑一遍**，
 * 端点由本 spec 内置的 stub HTTP 服务提供，可精确制造三种退化：
 *   `404`    没有 `/v1/models`            → 探针必须说 unavailable
 *   `garbage` 有 models，但 chat 返回非 chat 结构 → 探针**不得**产出计时/计数（新加的 choices 门）
 *   `valid`  结构完整的 chat 响应           → 探针应正常产出（成功路径也一并覆盖）
 *
 * 断言口径：**"必须不出现"比"必须出现"更重要**——失败被写成 `=false` / `=0` / 空串哈希，
 * 都是把"不知道"伪装成"知道"，是本项目最危险的一类缺陷。
 *
 * 附带覆盖：`runProbe` 在**非零退出**时抛错，因此每个通过的 `await runProbe(...)` 同时证明了
 * "探针跑完且退出码为 0"——该性质在 2026-09-28 实测中曾经是坏的（指标缺失时
 * `[ -n "$KV" ] && echo` 链会把整条命令的退出码带成非 0，见缺陷 #46）。
 */
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../../src/primitives/yaml-lite.js'

export const NAME = 'probe-degenerate（探针层：真跑 shell，失败不得被写成信号）'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const DIM_DIR = join(PKG_ROOT, 'assets', 'dimensions', 'framework')

const VALID_COMPLETION = JSON.stringify({
  id: 'stub-1',
  choices: [{
    index: 0,
    finish_reason: 'stop',
    message: { role: 'assistant', content: '张量并行把一层权重切成若干份。' },
    logprobs: { content: [{ token: '张', logprob: -0.1, top_logprobs: [{ token: '张', logprob: -0.1 }] }] },
  }],
  usage: { prompt_tokens: 12, completion_tokens: 16 },
})

function probeCommand(file, id) {
  const doc = parse(readFileSync(join(DIM_DIR, file), 'utf8'))
  const p = (doc.probes || []).find((x) => x.id === id)
  if (!p) throw new Error(`探针 ${id} 不在 ${file}`)
  return p.command
}

/** 起一个可切换行为的 stub 端点；fn 收到 baseUrl。 */
async function withStub(mode, fn) {
  const srv = createServer((req, res) => {
    const url = req.url || ''
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body) }
    if (url.startsWith('/v1/models')) {
      if (mode === '404') return json(404, '{"detail":"Not Found"}')
      return json(200, '{"object":"list","data":[{"id":"stub-model","object":"model"}]}')
    }
    if (url.startsWith('/v1/chat/completions')) {
      if (mode === '404') return json(404, '{"detail":"Not Found"}')
      if (mode === 'garbage') return json(200, '{"detail":"Not Found"}')
      // valid：区分流式与非流式
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        if (/"stream"\s*:\s*true/.test(body)) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(`data: {"choices":[{"delta":{"role":"assistant","content":"张"}}]}\n\n`)
          res.write(`data: ${VALID_COMPLETION}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        json(200, VALID_COMPLETION)
      })
      return
    }
    if (url.startsWith('/metrics')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('python_gc_objects_collected_total{generation="0"} 929.0\n')
      return
    }
    json(404, '{"detail":"Not Found"}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

/**
 * 异步执行探针 —— **必须异步**：stub 端点跑在本进程内，同步的 execFileSync 会阻塞事件循环，
 * 使 stub 永远无法应答（首次实现就踩了这个坑：表现为 bash ETIMEDOUT）。
 */
function runProbe(cmd, base, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', cmd], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        VLLM_BASE: base,
        MODEL_DIR: '/nonexistent-model-dir',
        SAMPLE_N: '2',
        SAMPLE_MAX_TOKENS: '48',
        ...extraEnv,
      },
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

export async function run(t) {
  const perf = probeCommand('vllm.yaml', 'perf-snapshot')
  const sweep = probeCommand('vllm.yaml', 'quality-sweep')
  const logits = probeCommand('vllm.yaml', 'logits-probe')

  // ── 场景 A：端点 404（没有 /v1/models）── 探针必须说“测不到”，且**一行数值都不许产出** ──
  await withStub('404', async (base) => {
    const out = await runProbe(perf, base)
    t.assert(out.includes('DSH-SIGNAL perf.unavailable=true'), 'A/perf：404 → perf.unavailable=true')
    for (const bad of ['perf.e2e_ms=', 'perf.ttft_ms=', 'perf.completion_tokens=', 'perf.kv_cache_usage=', 'perf.num_preemptions=']) {
      t.assert(!out.includes(bad), `A/perf：404 时不得产出 ${bad}（失败不是测量）`)
    }
    const s = await runProbe(sweep, base)
    t.assert(/quality\.sample\.\d+=n\/a/.test(s), 'A/sweep：404 → 采样输出 n/a')
    t.assert(!s.includes('e3b0c442'), 'A/sweep：不得出现空串哈希 e3b0c442（#38 回归）')
    t.assert(!/quality\.sample\.\d+=core_hash:/.test(s), 'A/sweep：404 时不得产出任何样本指纹')
    const l = await runProbe(logits, base)
    t.assert(l.includes('logits.prefill_repeat_consistent=n/a'), 'A/logits：404 → n/a')
    t.assert(!l.includes('prefill_repeat_consistent=false'), 'A/logits：404 时不得写成 false（#37 回归）')
  })

  // ── 场景 B：有 /v1/models，但 chat 返回非 chat 结构（"端点活着但不是 chat 端点"）──
  await withStub('garbage', async (base) => {
    const out = await runProbe(perf, base)
    t.assert(out.includes('DSH-SIGNAL perf.model=stub-model'), 'B/perf：models 可达 → 回显 model')
    t.assert(out.includes('DSH-SIGNAL perf.unavailable=true'), 'B/perf：chat 响应无 choices → unavailable（choices 门）')
    for (const bad of ['perf.e2e_ms=', 'perf.ttft_ms=', 'perf.completion_tokens=']) {
      t.assert(!out.includes(bad), `B/perf：无 choices 时不得产出 ${bad}（那只是"一次失败请求的耗时"）`)
    }
    t.assert(!out.includes('perf.completion_tokens=0'), 'B/perf：不得把解析失败伪造成 completion_tokens=0')
  })

  // ── 场景 C：结构完整的 chat 响应 → 成功路径也必须真的产出（防止"为了不假报而干脆不报"）──
  await withStub('valid', async (base) => {
    const out = await runProbe(perf, base)
    t.assert(/DSH-SIGNAL perf\.e2e_ms=\d+/.test(out), 'C/perf：有效响应 → 产出 e2e_ms')
    t.assert(/DSH-SIGNAL perf\.completion_tokens=16/.test(out), 'C/perf：从 usage 取到 completion_tokens=16')
    t.assert(/DSH-SIGNAL perf\.ttft_ms=\d+/.test(out), 'C/perf：流式首块 → 产出 ttft_ms')
    t.assert(!out.includes('perf.unavailable=true'), 'C/perf：有效响应不得再标 unavailable')

    const s = await runProbe(sweep, base)
    t.assert(/quality\.sample\.1=core_hash:[0-9a-f]{8}/.test(s), 'C/sweep：有效响应 → 产出样本指纹')
    t.assert(!s.includes('e3b0c442'), 'C/sweep：有效响应的指纹不得恰好是空串哈希')
    t.assert(/quality\.sweep\.valid=2\/2/.test(s), 'C/sweep：有效样本计数 = 2/2')

    const l = await runProbe(logits, base)
    t.assert(l.includes('logits.prefill_repeat_consistent=true'), 'C/logits：两次重算 logprob 相同 → true')
    t.assert(!l.includes('=n/a'), 'C/logits：有效响应不得落 n/a')
  })

  // ── 探针纪律（静态断言）──
  t.assert(!/sha256sum[^;]*\$CORE/.test(sweep) || sweep.includes('if [ -n \"$CORE\" ]'),
    'quality-sweep：不得对可能为空的变量取哈希（必须先判空）')
  for (const [name, cmd] of [['vllm perf-snapshot', perf], ['vllm quality-sweep', sweep], ['vllm logits-probe', logits]]) {
    t.assert(typeof cmd === 'string' && cmd.length > 200, `${name}：命令非空且完整`)
  }
  // 组合后的脚本必须是**合法 bash**：探针命令在 composer 里经过单引号/双引号/反斜杠转义，
  // 只读 YAML 看不出转义是否出错——这一条用 `bash -n` 真正验证（含新加的 choices 门与末尾 true）。
  {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { createCore } = await import('../../src/index.js')
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-probe-syntax-'))
    const core = createCore({ pkgRoot: PKG_ROOT, storageDir: join(tmp, 's'), persist: false })
    for (const dims of [
      { framework: 'vllm', runtime: 'docker', hardware: 'ascend-arm' },
      { framework: 'mindie', runtime: 'docker', hardware: 'ascend-arm' },
    ]) {
      const g = core.generateCollectScript({ description: '语法检查', dimensions: dims })
      const f = join(tmp, `${dims.framework}.sh`)
      writeFileSync(f, g.data.script)
      let err = null
      await new Promise((res) => execFile('bash', ['-n', f], (e) => { err = e; res() }))
      t.assert(err === null, `${dims.framework} 组合脚本通过 bash -n 语法检查（composer 转义正确）`)
      const perfLine = g.data.script.split('\n').find((l) => l.startsWith('emit "perf-snapshot"'))
      t.assert(!!perfLine && perfLine.includes('grep -c "choices"'), `${dims.framework}：组合后的 perf-snapshot 含 choices 门`)
      t.assert(!!perfLine && perfLine.trimEnd().endsWith("'; true'") || (!!perfLine && perfLine.includes('; true')),
        `${dims.framework}：组合后的 perf-snapshot 退出码已归零`)
    }
    rmSync(tmp, { recursive: true, force: true })
  }
  t.assert(perf.includes('grep -c "choices"'), 'perf-snapshot 含 choices 门（失败不产出计时/计数）')
  t.assert(perf.includes('completed_tokens",""') || perf.includes('completion_tokens\\",\\"\\"'), 'perf-snapshot 的 completion_tokens 缺省为空串而非 0')
  const mindiePerf = probeCommand('mindie.yaml', 'perf-snapshot')
  t.assert(mindiePerf.includes('MINDIE_ENDPOINT'), 'mindie 组合的 perf-snapshot 认 MINDIE_ENDPOINT（#44 回归）')
  t.assert(perf.includes('MINDIE_ENDPOINT'), 'vllm 组合的 perf-snapshot 同样兼容 MINDIE_ENDPOINT')
}
