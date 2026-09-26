/**
 * 拆包核对：确认刚打出来的 APK 里确实烘进了期望的值。
 *
 * 这不是"再加一层机制" —— 这是打完包之后拆开看一眼，跟"构建完跑一遍测试"是同一类事。
 * 之前那次事故（测试地址的包被发到公网）就是没有这一眼造成的。
 *
 * 不引第三方解压库：APK 就是一个 zip，这里只需要"按中央目录找条目、inflate、搜字节"。
 */
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CEN_SIGNATURE = 0x02014b50
const LOC_SIGNATURE = 0x04034b50

function centralDirectoryOffset(buf) {
  const lowest = Math.max(0, buf.length - (22 + 0xFFFF))
  for (let at = buf.length - 22; at >= lowest; at -= 1) {
    if (buf.readUInt32LE(at) === EOCD_SIGNATURE)
      return buf.readUInt32LE(at + 16)
  }
  return -1
}

/**
 * 把包里每个条目解出来。
 *
 * 覆盖**全部**条目而不只是 `classes*.dex`：地址和 Firebase 值确实落在 dex（BuildConfig
 * 常量），但 App Links 的域名只在 `AndroidManifest.xml` 里 —— 那是二进制 XML，还通常
 * 是压缩存储的，光靠"在文件字节里搜"看不见。只搜 dex 的话，这类值会一律报"不在包里"，
 * 而"报错了"和"真的错了"分不开，这个核对就没用了。
 *
 * 解不动的条目跳过：这是核对，不是解包工具。
 */
function packageEntries(buf) {
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

    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOC_SIGNATURE)
      continue
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28)
    const raw = buf.subarray(dataAt, dataAt + compressedSize)
    try {
      out.push(method === 0 ? raw : inflateRawSync(raw))
    }
    catch {
      // 坏条目跳过：这是核对，不是解包工具。
    }
  }
  return out
}

/**
 * 检查 APK 里是否含有某个字符串。
 *
 * 二进制 XML 会把字符串按 UTF-16 存，所以两种编码都试一遍。
 *
 * @param apkPath APK 文件路径。
 * @param needle 要找的字符串。
 * @returns 找到为 true；文件读不了、结构不认识、空串都返回 false（不确定时不放行）。
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
  const utf8 = Buffer.from(needle, 'utf8')
  const utf16 = Buffer.from(needle, 'utf16le')
  if (buf.includes(utf8) || buf.includes(utf16))
    return true
  return packageEntries(buf).some(entry => entry.includes(utf8) || entry.includes(utf16))
}

/**
 * 核对一个 APK 里烘进了哪些值，返回逐项结果。
 *
 * @param apkPath APK 文件路径。
 * @param expected `{ 名称: 期望的字符串 }`，空串的项会被跳过。
 * @returns `{ 名称: true/false }` —— true 表示"产物里确实有这个值"。
 */
export function verifyBakedValues(apkPath, expected) {
  const result = {}
  for (const [name, value] of Object.entries(expected)) {
    if (typeof value !== 'string' || value === '')
      continue
    result[name] = apkContains(apkPath, value)
  }
  return result
}
