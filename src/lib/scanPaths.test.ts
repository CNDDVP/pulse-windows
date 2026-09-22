import {describe,expect,it} from 'vitest';
import {
  EXTRA_PATHS_PER_SOURCE_LIMIT, countExtraPaths, extraDirInputError,
  isAbsoluteDirPath, normalizedExtraPaths,
} from './scanPaths';

describe('isAbsoluteDirPath（与后端 Windows 目标 Path::is_absolute 同界，边界按本机 rustc 实测）', () => {
  it('accepts drive roots (both separators) and UNC paths', () => {
    for (const p of ['D:\\logs', 'D:/logs', 'C:\\', 'z:/x', '\\\\server\\share']) {
      expect(isAbsoluteDirPath(p), p).toBe(true);
    }
  });
  it('accepts forward/mixed UNC and verbatim/device forms exactly like the backend', () => {
    // 与后端一致放行（旧实现漏掉正向 UNC、误放退化 UNC）。
    for (const p of ['//server/share', '/\\server\\share', '\\/server\\share', '\\\\?\\C:\\x', '\\\\.\\pipe']) {
      expect(isAbsoluteDirPath(p), p).toBe(true);
    }
  });
  it('rejects relative, rooted-only, drive-relative and unix paths', () => {
    for (const p of ['relative/dir', 'logs', '.\\logs', '\\foo', 'D:logs', 'C:', '', '/unix/root']) {
      expect(isAbsoluteDirPath(p), p).toBe(false);
    }
  });
  it('rejects degenerate UNC forms the backend also rejects (is_absolute=false)', () => {
    // 旧实现 startsWith('\\\\') 把这些全放行，前端过、后端整次拒绝保存。
    for (const p of ['\\\\', '\\\\server', '\\\\server\\', '\\\\\\\\', '\\\\\\server\\share', '///server/share']) {
      expect(isAbsoluteDirPath(p), p).toBe(false);
    }
  });
});

describe('extraDirInputError', () => {
  it('null for a valid non-duplicate path under the limit', () => {
    expect(extraDirInputError('  D:\\logs\\custom  ', [])).toBeNull();
  });
  it('rejects empty, relative, overlong input; whitespace is trimmed before checks', () => {
    expect(extraDirInputError('   ', [])).toBe('路径不能为空');
    expect(extraDirInputError('logs\\custom', [])).toContain('绝对路径');
    expect(extraDirInputError('D:' + '\\x'.repeat(1100), [])).toContain('路径过长');
  });
  it('rejects duplicates and the 21st entry per source', () => {
    const twenty = Array.from({length: EXTRA_PATHS_PER_SOURCE_LIMIT}, (_, i) => `D:\\d${i}`);
    expect(extraDirInputError('D:\\d0', twenty)).toBe('该目录已添加');
    expect(extraDirInputError('D:\\new', twenty)).toBe('每来源最多 20 条');
    expect(extraDirInputError('D:\\new', twenty.slice(0, 19))).toBeNull();
  });
  it('rejects Windows case/separator variants of an existing dir as duplicates', () => {
    // Windows 路径大小写不敏感、/ 与 \ 同义：精确字符串比较会让同一物理目录
    // 以两个 path_key 进账本（真实双计）。判重键折叠大小写与分隔符，仅用于比较。
    expect(extraDirInputError('d:\\LOGS', ['D:\\logs'])).toBe('该目录已添加');
    expect(extraDirInputError('D:/logs', ['D:\\logs'])).toBe('该目录已添加');
    expect(extraDirInputError('D:\\logs\\sub', ['D:\\logs'])).toBeNull();
    expect(extraDirInputError('\\\\SERVER\\share', ['\\\\server\\SHARE'])).toBe('该目录已添加');
  });
});

describe('normalizedExtraPaths（保存口径）', () => {
  it('trims entries, drops empties and drops sources left empty', () => {
    expect(normalizedExtraPaths({
      claude: ['  D:\\a ', '', 'D:\\b'],
      codex: ['   '],
    })).toEqual({claude: ['D:\\a', 'D:\\b']});
  });
  it('preserves source keys outside SPEND_SOURCES (they are valid_id for the backend)', () => {
    expect(normalizedExtraPaths({future_source: ['E:\\keep'], claude: []}))
      .toEqual({future_source: ['E:\\keep']});
  });
  it('tolerates a non-array value without crashing', () => {
    expect(normalizedExtraPaths({claude: undefined as unknown as string[]})).toEqual({});
  });
});

describe('countExtraPaths', () => {
  it('sums per-source lengths', () => {
    expect(countExtraPaths({claude: ['D:\\a', 'D:\\b'], codex: ['E:\\c']})).toBe(3);
    expect(countExtraPaths({})).toBe(0);
  });
});
