/**
 * 通配符匹配函数
 * 支持 * 匹配任意字符（包括空字符）
 * 支持 ? 匹配单个字符
 * @param pattern 通配符模式，如 "clk*", "*data*", "top.*.clk"
 * @param text 要匹配的文本
 * @returns 是否匹配
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  if (!pattern) return true;
  if (!text) return false;

  // 将通配符模式转换为正则表达式
  // *  -> .* (匹配任意字符)
  // ?  -> .  (匹配单个字符)
  // 其他字符进行转义
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义特殊正则字符
    .replace(/\*/g, '.*')                   // * 匹配任意字符
    .replace(/\?/g, '.');                   // ? 匹配单个字符

  try {
    const regex = new RegExp(`^${regexPattern}$`, 'i'); // i 表示不区分大小写
    return regex.test(text);
  } catch {
    // 如果正则表达式无效，回退到简单的包含检查
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * 检查文本是否匹配任意一个通配符模式
 * @param patterns 通配符模式数组
 * @param text 要匹配的文本
 * @returns 是否匹配任意一个模式
 */
export function wildcardMatchAny(patterns: string[], text: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some(pattern => wildcardMatch(pattern, text));
}
