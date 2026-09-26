/**
 * 从 APK 里读出一个字符串，用来**在发布之前核对产物**。
 *
 * 为什么需要它：构建这件事有一段它不拥有的过程 —— Gradle 的构建目录是共享的（同一个安卓
 * 工程可以被多个 profile 指向），产物也可能被别的进程先写一遍。于是"命令行的参数是对的"
 * 完全不能推出"这个 APK 里的值是对的"。曾经就是照命令行判断，把一个指向测试地址的包发布了
 * 出去，手机装完怎么都连不上。
 *
 * 所以判据只能是产物本身：把 APK 拆开，在 dex 里找那个值。找不到就不许发布。
 *
 * 不引第三方解压库：APK 就是一个 zip，这里只需要"按中央目录找到 dex、inflate、搜字节"，
 * 用 `node:zlib` 足够，也避免为一个启动时未必用到的能力背一条依赖。
 */
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/** zip 中央目录结尾的标志。它后面可能跟着长度不定的注释，所以从尾部往回找。 */
const EOCD_SIGNATURE = 0x06054b50
/** 单个条目的中央目录头。 */
const CEN_SIGNATURE = 0x02014b50
/** 单个条目的本地文件头。 */
const LOC_SIGNATURE = 0x04034b50

/**
 * 找到中央目录的起始偏移，找不到返回 -1。
 *
 * @param buf 整个 zip 文件。
 */
function centralDirectoryOffset(buf) {
  // EOCD 是 22 字节固定部分加最多 65535 字节注释，所以往回找 22 + 65535 就够了。
  const lowest = Math.max(0, buf.length - (22 + 0xFFFF))
  for (let at = buf.length - 22; at >= lowest; at -= 1) {
    if (buf.readUInt32LE(at) === EOCD_SIGNATURE)
      return buf.readUInt32LE(at + 16)
  }
  return -1
}

/**
 * 取出所有 dex 条目的内容。
 *
 * 只认 `classes*.dex`：BuildConfig 里的常量就在那里，别的条目既大又无关。
 *
 * @param buf 整个 zip 文件。
 * @returns 解压后的 dex 缓冲区；单个条目坏掉就跳过它，而不是让整次检查失败。
 */
function dexEntries(buf) {
  const start = centralDirectoryOffset(buf)
  if (start < 0)
    return []
  const out = []
  let at = start
  while (at + 46 <= buf.length && buf.readUInt32LE(at) === CEN_SIGNATURE) {
    const method = buf.readUInt16LE(at + 10)
    const compressedSize = buf.readUInt32LE(at + 20)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength

    if (!/^classes\d*\.dex$/.test(name))
      continue
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOC_SIGNATURE)
      continue
    // 数据起点要按**本地头自己的**名字/扩展字段长度算：中央目录里那份可能被改过，
    // 用错了偏移读出来的就是一段垃圾，而搜索会安静地报"没找到"。
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28)
    const raw = buf.subarray(dataAt, dataAt + compressedSize)
    try {
      out.push(method === 0 ? raw : inflateRawSync(raw))
    }
    catch {
      // 坏条目跳过：这是核对，不是解包工具，没必要为一个读不了的文件中断整次检查。
    }
  }
  return out
}

/**
 * APK 里是否含有这个字符串。
 *
 * @param apkPath APK 文件路径。
 * @param needle 要找的字符串。空串一律返回 false —— "配置里没填"不能被当成"核对通过"。
 * @returns 找到为 true。文件读不了、结构不认识都返回 false（**不确定时不放行**）。
 */
export function apkContains(apkPath, needle) {
  if (typeof needle !== 'string' || needle === '')
    return false
  let buf
  try {
    buf = readFileSync(apkPath)
  }
  catch {
    return false
  }
  const target = Buffer.from(needle, 'utf8')
  // 存储型条目（method 0）在原始字节里就能看到，先做一次便宜的全文搜索。
  if (buf.includes(target))
    return true
  return dexEntries(buf).some(entry => entry.includes(target))
}
