/**
 * 检查 client.js 里有没有把 children 当第三个参数传给 jsx。
 *
 * react/jsx-runtime 的 jsx 签名是 (type, props, key) —— 第三个参数是 **key**，不是 children。
 * 写成 h('div', props, [children]) 不会报错，只会静默渲染出一个空元素，
 * 而这种"看起来加载了、却点不着"的问题最难查。这个脚本把它变成一条机器能发现的规则。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

// 逐个 h( 调用做括号配平，找出"第二个参数是对象、第三个参数是数组"的写法。
const offenders = []
for (let at = source.indexOf('h('); at !== -1; at = source.indexOf('h(', at + 2)) {
  let depth = 0
  let quote = ''
  // 从 h 后面的 '(' 开始扫，否则深度整体差一，遇到第一个 '}' 就会误判为调用结束。
  let index = at + 1
  const commas = []
  for (; index < source.length; index += 1) {
    const ch = source[index]
    if (quote !== '') {
      if (ch === '\\') index += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) break
    }
    else if (ch === ',' && depth === 1) commas.push(index)
  }
  if (commas.length < 2) continue
  const third = source.slice(commas[1] + 1, index).trimStart()
  if (third.startsWith('['))
    offenders.push(source.slice(0, at).split('\n').length)
}

if (offenders.length > 0) {
  console.error(`client.js: jsx 的第三个参数是 key，不是 children；子节点要写进 props.children（第 ${offenders.join(', ')} 行）`)
  process.exit(1)
}
console.log('client.js: jsx 调用没有把 children 当第三个参数')
