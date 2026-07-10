/** Convert deployment glob syntax into a platform-aware regular expression. */
export function globToRegex(globPattern: string, platform = process.platform): string {
  const isWindows = platform === "win32";
  const pathSeparator = isWindows ? "\\\\" : "/";
  const pathSeparatorClass = isWindows ? "[\\\\\\/]" : "\\/";

  let regexPattern = globPattern
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "__SINGLESTAR__")
    .replace(/\?/g, "__QUESTION__")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(
      /__DOUBLESTAR__\/__SINGLESTAR__/g,
      "(__DOUBLESTAR__/)?__SINGLESTAR__",
    )
    .replace(/__DOUBLESTAR__/g, ".*")
    .replace(/__SINGLESTAR__/g, `[^${pathSeparator}]*`)
    .replace(/__QUESTION__/g, `[^${pathSeparator}]`);

  regexPattern = regexPattern.replace(/\//g, pathSeparatorClass);
  return regexPattern;
}
