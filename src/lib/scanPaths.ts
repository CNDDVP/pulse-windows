// Round5A 项目四：扫描路径面板共用的纯校验/归一化层。
// 后端 types::validate_token_spend_extra_paths 仍是权威校验（保存命令会整表校验、非法整次拒绝）；
// 这里的规则与其同界，只为了让面板在添加时就给出即时反馈，而不是等保存才报错。
import {SPEND_SOURCES} from './spend';

/** 每来源附加扫描目录上限（与后端 TOKEN_SPEND_EXTRA_PATHS_PER_SOURCE 一致，types.rs:4）。 */
export const EXTRA_PATHS_PER_SOURCE_LIMIT = 20;
/** 单条路径长度上限（与后端同界，types.rs:15）。 */
export const EXTRA_PATH_MAX_LEN = 1024;

/**
 * 与后端 std::path::Path::is_absolute（Windows 目标）同界的纯校验。边界按本机 rustc 实测对齐
 * （2026-09-23，rustc 1.98.0，与 types.rs:14 的后端谓词同一实现）：
 *  - 盘符根：`D:\`、`D:/`（`C:`、`C:logs` 无分隔符=前缀非根，两侧都拒绝）；
 *  - UNC：两个分隔符开头 + server + 恰一个分隔符 + share（`\\server\share`、`//server/share`、
 *    混合 `/\server\share` 也同界）；退化形式（`\\`、`\\server`、`\\server\`）与三连分隔符
 *    （`\\\server\share`、`///server/share`）后端 is_absolute=false，此处同样拒绝；
 *  - verbatim/device（`\\?\…`、`\\.\…`）与后端一致放行。
 * 旧实现的 startsWith('\\\\') 会放行退化 UNC（前端过、后端整次拒绝保存），已修正。
 * 存在性一律不校验：目录可先配置后创建（后端口径）。
 */
export function isAbsoluteDirPath(p: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  // verbatim（\\?\…）与 device（\\.\…）：两个分隔符后跟 ?/. 再跟一个分隔符，后端恒为绝对路径。
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return true;
  // UNC：server（不含分隔符）+ 恰一个分隔符 + share（不含分隔符）；share 后跟什么都可以。
  return /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(p);
}

/**
 * 判重键（仅用于查重比较，配置里保留用户输入原文）：本应用是 Windows 端，路径大小写不敏感、
 * `/` 与 `\` 同义——精确字符串比较会让 `D:\logs` 与 `d:/LOGS` 被当成两个目录各自扫描，
 * 同一物理目录以两个不同 path_key 进账本（后端 path_key 按 sha256(路径原文) 区分，无法兜底）。
 */
function extraPathDedupKey(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase();
}

/**
 * 「添加」输入校验：返回错误文案；null = 可添加。
 * 超上限 / 重复（Windows 语义）/ 非绝对路径在此拒绝，不进草稿；保存时后端仍会整表校验。
 */
export function extraDirInputError(raw: string, existing: readonly string[]): string | null {
  const p = raw.trim();
  if (!p) return '路径不能为空';
  if (!isAbsoluteDirPath(p)) return '必须是绝对路径（如 D:\\logs 或 \\\\server\\share）';
  if (p.length > EXTRA_PATH_MAX_LEN) return `路径过长（上限 ${EXTRA_PATH_MAX_LEN} 字符）`;
  const key = extraPathDedupKey(p);
  if (existing.some(e => extraPathDedupKey(e) === key)) return '该目录已添加';
  if (existing.length >= EXTRA_PATHS_PER_SOURCE_LIMIT) return `每来源最多 ${EXTRA_PATHS_PER_SOURCE_LIMIT} 条`;
  return null;
}

/**
 * 保存口径归一化：逐条 trim、去空、去掉清空后的来源键。
 * 面板下拉只暴露 SPEND_SOURCES，但设置里可能存在其它 valid_id 来源键
 * （后端只要求 valid_id 白名单）——原样保留，不因保存面板改动而静默删除。
 */
export function normalizedExtraPaths(map: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [src, dirs] of Object.entries(map)) {
    const cleaned = (Array.isArray(dirs) ? dirs : []).map(d => String(d).trim()).filter(d => d !== '');
    if (cleaned.length) out[src] = cleaned;
  }
  return out;
}

/** 面板标题的已配置目录总数。 */
export function countExtraPaths(map: Record<string, string[]>): number {
  return Object.values(map).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
}

/** 来源标识 → 展示名（未知标识原样返回，与后端 types::name 的兜底一致）。 */
export function extraPathSourceLabel(id: string): string {
  return SPEND_SOURCES.find(([s]) => s === id)?.[1] ?? id;
}
