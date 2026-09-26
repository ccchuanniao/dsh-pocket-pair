/**
 * 冒烟检查：把宿主半侧的几个模块真的 import 一遍。
 *
 * 存在的理由很具体：`node --check` 只验语法，`lint-client.mjs` 只管 jsx 的 children。
 * 而"用了一个没导入的标识符"（比如漏了 `join`）语法完全合法，只有真的执行到那一行
 * 才会抛 ReferenceError —— 那已经是运行时、已经在用户面前了。这个脚本把它提前到提交前。
 *
 * 注意这里只 import，不调用；模块顶层的引用错误足以暴露问题。
 */
const modules = ['../lib/index.js', '../lib/lan-gate.js', '../lib/build.js', '../lib/fcm.js', '../lib/summarize.js']

for (const path of modules) {
  try {
    await import(new URL(path, import.meta.url))
    console.log(`导入成功: ${path}`)
  }
  catch (error) {
    console.error(`导入失败: ${path}\n  ${error}`)
    process.exit(1)
  }
}
