import { type FileRecord, pathSchema } from "@cf-sync/protocol";
import * as v from "valibot";

export interface VaultLink {
  syntax: "wikilink" | "markdown";
  target: string;
  embed: boolean;
  raw: string;
  /** UTF-16 offset in the original note. */
  offset: number;
  alias?: string;
}

interface LinkTarget {
  target: string;
  /** Includes the leading #; does not assert that the heading or block exists. */
  subpath?: string;
  heading?: string;
  blockId?: string;
}

export type LinkResolution = LinkTarget &
  (
    | { status: "resolved"; file: FileRecord }
    | { status: "ambiguous"; candidates: FileRecord[] }
    | { status: "missing"; reason: "not-found" | "invalid-target" | "outside-vault" }
    | { status: "external" }
  );

function escaped(text: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; text[index] === "\\"; index--) {
    slashes++;
  }
  return slashes % 2 === 1;
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

/** Mask fenced/inline code without changing offsets. This is not a full Markdown parser. */
function withoutCode(text: string): string {
  const characters = text.split("");
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (characters[index] !== "\n") {
        characters[index] = " ";
      }
    }
  };
  let fence: string | undefined;
  let offset = 0;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      mask(offset, offset + line.length);
      if (
        marker &&
        marker[1]?.[0] === fence[0] &&
        (marker[1]?.length ?? 0) >= fence.length &&
        !marker[2]?.trim()
      ) {
        fence = undefined;
      }
    } else if (marker && !(marker[1]?.startsWith("`") && marker[2]?.includes("`"))) {
      fence = marker[1];
      mask(offset, offset + line.length);
    }
    offset += line.length + 1;
  }

  maskInlineCode(characters, mask);
  return characters.join("");
}

function maskInlineCode(characters: string[], mask: (start: number, end: number) => void): void {
  const masked = characters.join("");
  const ticks = [...masked.matchAll(/`+/g)];
  const next = new Map<number, number>();
  const closingIndices = new Map<number, number>();
  for (let index = ticks.length - 1; index >= 0; index--) {
    const length = ticks[index]?.[0].length ?? 0;
    closingIndices.set(index, next.get(length) ?? ticks.length);
    next.set(length, index);
  }
  for (let index = 0; index < ticks.length; index++) {
    const opening = ticks[index];
    if (!opening || escaped(masked, opening.index)) {
      continue;
    }
    const closingIndex = closingIndices.get(index) ?? ticks.length;
    const closing = ticks[closingIndex];
    if (closing) {
      mask(opening.index, closing.index + closing[0].length);
      index = closingIndex;
    }
  }
}

interface LinkSyntax {
  text: string;
  pairs: Map<number, number>;
  delimiters: Map<string, number[]>;
}

/** Index delimiters once, so malformed opening syntax cannot rescan the whole suffix. */
function indexSyntax(text: string): LinkSyntax {
  const pairs = new Map<number, number>();
  const brackets: number[] = [];
  const parentheses: number[] = [];
  const delimiters = new Map<string, number[]>();
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset] ?? "";
    if (character === "\\" && text[offset + 1] !== "\n") {
      offset++;
      continue;
    }
    if (character === "[") {
      brackets.push(offset);
    } else if (character === "(") {
      parentheses.push(offset);
    } else if (character === "]" || character === ")") {
      let stack = brackets;
      if (character === ")") {
        stack = parentheses;
      }
      const opening = stack.pop();
      if (opening !== undefined) {
        pairs.set(opening, offset);
      }
    }
    for (const delimiter of [character, text.slice(offset, offset + 2)]) {
      if (["'", '"', ">", ")", "\n", "]]"].includes(delimiter)) {
        const positions = delimiters.get(delimiter) ?? [];
        positions.push(offset);
        delimiters.set(delimiter, positions);
      }
    }
  }
  return { text, pairs, delimiters };
}

function skipWhitespace(text: string, offset: number): number {
  while (offset < text.length && /\s/.test(text[offset] ?? "")) {
    offset++;
  }
  return offset;
}

function findDelimiter(syntax: LinkSyntax, offset: number, delimiter: string): number {
  const positions = syntax.delimiters.get(delimiter) ?? [];
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((positions[middle] ?? syntax.text.length) < offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return positions[low] ?? syntax.text.length;
}

function markdownTarget(
  syntax: LinkSyntax,
  start: number,
): { target: string; end: number } | undefined {
  const { text, pairs } = syntax;
  if (text[start] === "<") {
    const end = findDelimiter(syntax, start + 1, ">");
    if (text[end] === ">" && findDelimiter(syntax, start + 1, "\n") > end) {
      return { target: text.slice(start + 1, end), end: end + 1 };
    }
    return undefined;
  }
  let end = start;
  for (; end < text.length; end++) {
    const character = text[end];
    if (character === "\\") {
      end++;
    } else if (character === "(") {
      const closing = pairs.get(end);
      if (closing === undefined) {
        return undefined;
      }
      end = closing;
    } else if (character === ")" || /\s/.test(character ?? "")) {
      break;
    }
  }
  return { target: text.slice(start, end), end };
}

function markdownDestination(
  syntax: LinkSyntax,
  opening: number,
): { target: string; end: number } | undefined {
  const { text } = syntax;
  const parsed = markdownTarget(syntax, skipWhitespace(text, opening + 1));
  if (!parsed) {
    return undefined;
  }
  let cursor = skipWhitespace(text, parsed.end);
  const quote = text[cursor];
  if (cursor > parsed.end && (quote === '"' || quote === "'" || quote === "(")) {
    let close = quote;
    if (quote === "(") {
      close = ")";
    }
    cursor = findDelimiter(syntax, cursor + 1, close);
    if (text[cursor] !== close) {
      return undefined;
    }
    cursor = skipWhitespace(text, cursor + 1);
  }
  if (text[cursor] === ")") {
    return { target: unescapeMarkdown(parsed.target), end: cursor + 1 };
  }
  return undefined;
}

function wikilinkAt(
  syntax: LinkSyntax,
  opening: number,
  offset: number,
  embed: boolean,
): VaultLink | undefined {
  const { text } = syntax;
  const end = findDelimiter(syntax, opening + 2, "]]");
  if (end === text.length || findDelimiter(syntax, opening + 2, "\n") < end) {
    return undefined;
  }
  const body = text.slice(opening + 2, end);
  const link: VaultLink = {
    syntax: "wikilink",
    target: body.trim(),
    embed,
    raw: text.slice(offset, end + 2),
    offset,
  };
  const separator = body.indexOf("|");
  if (separator >= 0) {
    link.target = body.slice(0, separator).trim();
    link.alias = body.slice(separator + 1);
  }
  return link;
}

function markdownAt(
  syntax: LinkSyntax,
  opening: number,
  offset: number,
  embed: boolean,
  original: string,
): VaultLink | undefined {
  const { text, pairs } = syntax;
  const closing = pairs.get(opening);
  if (closing === undefined || text[closing + 1] !== "(") {
    return undefined;
  }
  const destination = markdownDestination(syntax, closing + 1);
  if (!destination) {
    return undefined;
  }
  return {
    syntax: "markdown",
    target: destination.target,
    embed,
    raw: text.slice(offset, destination.end),
    offset,
    alias: unescapeMarkdown(original.slice(opening + 1, closing)),
  };
}

/** Extract inline wikilinks and Markdown links/images, excluding fenced and inline code.
 * Reference-style links, HTML, frontmatter aliases, and full Obsidian syntax are not parsed.
 * Stops after `limit` results (default 1000); callers should also bound input length.
 */
export function extractLinks(text: string, limit = 1000): VaultLink[] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Link limit must be a nonnegative safe integer");
  }
  if (limit === 0) {
    return [];
  }
  const content = withoutCode(text);
  const syntax = indexSyntax(content);
  const links: VaultLink[] = [];
  for (let offset = 0; offset < content.length && links.length < limit; offset++) {
    const embed = content[offset] === "!" && content[offset + 1] === "[";
    const opening = offset + Number(embed);
    if (content[opening] !== "[" || escaped(content, offset)) {
      continue;
    }
    let link: VaultLink | undefined;
    if (content[opening + 1] === "[") {
      link = wikilinkAt(syntax, opening, offset, embed);
    } else {
      link = markdownAt(syntax, opening, offset, embed, text);
    }
    if (link) {
      // Retain the exact original source, including inline code inside labels.
      link.raw = text.slice(offset, offset + link.raw.length);
      links.push(link);
      offset += link.raw.length - 1;
    }
  }
  return links;
}

function key(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function normalizePath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (!parts.length) {
        return;
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function choose(matches: FileRecord[], target: LinkTarget): LinkResolution | undefined {
  const unique = [...new Map(matches.map((file) => [file.id, file])).values()];
  const [file] = unique;
  if (unique.length === 1 && file) {
    return { ...target, status: "resolved", file };
  }
  if (unique.length > 1) {
    return {
      ...target,
      status: "ambiguous",
      candidates: unique.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }
  return undefined;
}

function parseTarget(decoded: string): { path: string; target: LinkTarget } {
  const hash = decoded.indexOf("#");
  const target: LinkTarget = { target: decoded };
  if (hash < 0) {
    return { path: decoded, target };
  }
  target.subpath = decoded.slice(hash);
  const fragment = target.subpath.slice(1);
  if (fragment.startsWith("^")) {
    target.blockId = fragment.slice(1);
  } else if (fragment) {
    target.heading = fragment;
  }
  return { path: decoded.slice(0, hash), target };
}

function missing(
  target: LinkTarget,
  reason: "not-found" | "invalid-target" | "outside-vault",
): LinkResolution {
  return { ...target, status: "missing", reason };
}

function matchPath(
  candidate: string,
  files: readonly FileRecord[],
  target: LinkTarget,
): LinkResolution | undefined {
  const exact = choose(
    files.filter((file) => key(file.path) === key(candidate)),
    target,
  );
  return (
    exact ??
    choose(
      files.filter((file) => key(file.path) === key(`${candidate}.md`)),
      target,
    )
  );
}

function resolvePath(
  path: string,
  sourcePath: string,
  files: readonly FileRecord[],
  target: LinkTarget,
): LinkResolution {
  const relative = /^(?:\.\.?\/)/.test(path);
  const rooted = path.startsWith("/");
  const sourceFolder = sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1);
  let combined = path;
  if (relative) {
    combined = sourceFolder + path;
  }
  const base = normalizePath(combined);
  if (base === undefined) {
    return missing(target, "outside-vault");
  }
  if (!v.is(pathSchema, base)) {
    return missing(target, "invalid-target");
  }
  // Parent segments must never be reinterpreted as a shortest-name link.
  if (relative || rooted || path.split("/").includes("..")) {
    return matchPath(base, files, target) ?? missing(target, "not-found");
  }
  const adjacent = normalizePath(sourceFolder + path);
  let direct: LinkResolution | undefined;
  // Obsidian folder-qualified paths start at the vault root.
  if (path.includes("/")) {
    direct = matchPath(base, files, target);
  }
  if (adjacent) {
    direct ??= matchPath(adjacent, files, target);
  }
  direct ??= matchPath(base, files, target);
  if (direct) {
    return direct;
  }
  const suffix = `/${key(base)}`;
  const matches = files.filter((file) => {
    const filePath = key(file.path);
    return filePath.endsWith(suffix) || filePath.endsWith(`${suffix}.md`);
  });
  return choose(matches, target) ?? missing(target, "not-found");
}

/** Resolve against a supplied vault snapshot only; never fetch an external destination.
 * Explicit ./ and ../ links are strictly relative, and / links are strictly root-based.
 * Folder-qualified paths prefer the root; bare names prefer the source folder.
 * If neither direct path exists, use a unique path suffix.
 * Ambiguous suffixes are reported instead of guessing Obsidian's UI selection.
 */
export function resolveLink(
  link: VaultLink | string,
  sourcePath: string,
  files: readonly FileRecord[],
): LinkResolution {
  let raw = link;
  if (typeof raw !== "string") {
    raw = raw.target;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.trim());
  } catch {
    return missing({ target: raw }, "invalid-target");
  }
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(decoded)) {
    return { status: "external", target: decoded };
  }
  const { path, target } = parseTarget(decoded);
  if (!v.is(pathSchema, sourcePath)) {
    return missing(target, "invalid-target");
  }
  if (!path) {
    const source = choose(
      files.filter((file) => key(file.path) === key(sourcePath)),
      target,
    );
    return source ?? missing(target, "not-found");
  }
  return resolvePath(path, sourcePath, files, target);
}
