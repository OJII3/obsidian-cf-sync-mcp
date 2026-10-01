import type { FileRecord } from "@cf-sync/protocol";
import { describe, expect, it } from "vitest";

import { extractLinks, resolveLink } from "../src/service/obsidian-links";

function file(path: string, kind: FileRecord["kind"] = "text"): FileRecord {
  return {
    id: path,
    path,
    kind,
    revision: 1,
    pathRevision: 1,
    digest: "",
    size: 0,
    conflict: false,
  };
}

const files = [
  file("Home.md"),
  file("Projects/Source.md"),
  file("Projects/Note.md"),
  file("Note.md"),
  file("Archive/Only Note.md"),
  file("Archive/Shared.md"),
  file("Other/Shared.md"),
  file("Assets/image.png", "blob"),
];

function resolve(target: string, sourcePath = "Projects/Source.md", snapshot = files) {
  return resolveLink(target, sourcePath, snapshot);
}

describe("Obsidian inline link extraction", () => {
  it("extracts wikilinks, aliases, headings, blocks and embeds in document order", () => {
    expect(
      extractLinks("See [[Note#Heading|display]] and ![[Assets/image.png|200]] [[#^block-id]]."),
    ).toEqual([
      {
        syntax: "wikilink",
        target: "Note#Heading",
        alias: "display",
        embed: false,
        raw: "[[Note#Heading|display]]",
        offset: 4,
      },
      {
        syntax: "wikilink",
        target: "Assets/image.png",
        alias: "200",
        embed: true,
        raw: "![[Assets/image.png|200]]",
        offset: 33,
      },
      { syntax: "wikilink", target: "#^block-id", embed: false, raw: "[[#^block-id]]", offset: 59 },
    ]);
  });

  it("parses Markdown destinations, balanced parentheses, images and optional titles", () => {
    const links = extractLinks(
      '[label](../Home.md#heading) ![pic](Assets/image.png "title") [brackets [ok]](<Only Note.md>) [paren](Note%20(1).md) [escaped](Note\\(2\\).md)',
    );
    expect(links.map(({ target, embed, alias }) => ({ target, embed, alias }))).toEqual([
      { target: "../Home.md#heading", embed: false, alias: "label" },
      { target: "Assets/image.png", embed: true, alias: "pic" },
      { target: "Only Note.md", embed: false, alias: "brackets [ok]" },
      { target: "Note%20(1).md", embed: false, alias: "paren" },
      { target: "Note(2).md", embed: false, alias: "escaped" },
    ]);
  });

  it("ignores fenced code, inline code, escaped syntax and malformed links", () => {
    const text = [
      "`[[inline]]` `` ` [inline](hidden) `` [[visible]]",
      "```md",
      "[[fenced]]",
      "````",
      "~~~",
      "[fenced](hidden)",
      "~~~",
      "\\[[escaped]] \\[escaped](hidden) [broken](unclosed [[also broken",
      "[[after]]",
      "```",
      "[[unclosed fence]]",
    ].join("\n");
    expect(extractLinks(text).map(({ target }) => target)).toEqual(["visible", "after"]);
  });

  it("keeps inline code in Markdown display text", () => {
    expect(extractLinks("[use `code`](Home.md)")[0]).toMatchObject({
      alias: "use `code`",
      target: "Home.md",
      raw: "[use `code`](Home.md)",
    });
  });

  it("keeps original offsets and raw syntax after multiline code spans", () => {
    const text = "前 `code\n[[hidden]]` and ![[Home]]";
    const [link] = extractLinks(text);
    expect(link).toMatchObject({
      offset: text.indexOf("![[Home]]"),
      raw: "![[Home]]",
      target: "Home",
    });
  });

  it("bounds valid link extraction by the requested limit and a default of 1000", () => {
    const text = "[[Home]] [note](Note.md) ![[image.png]]";
    expect(extractLinks(text, 2).map(({ target }) => target)).toEqual(["Home", "Note.md"]);
    expect(extractLinks(text, 0)).toEqual([]);
    expect(extractLinks("[[Home]] ".repeat(1100))).toHaveLength(1000);
    expect(() => extractLinks(text, -1)).toThrow(RangeError);
    expect(() => extractLinks(text, Number.NaN)).toThrow(RangeError);
  });

  it.each([
    ["unmatched brackets", "[".repeat(65_536)],
    ["unmatched Markdown destinations", "[x](".repeat(16_384)],
    ["newline-separated wikilink closings", "[[x".repeat(21_845) + "\n]]"],
    ["multiline angle destinations", "[x](<".repeat(13_107) + "\n>"],
    ["escaped destination characters", "[x](" + "\\".repeat(65_536)],
  ])("handles 64 KiB of %s without quadratic rescanning", (_name, text) => {
    const start = performance.now();
    expect(extractLinks(text)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("handles unmatched backtick runs while keeping later links", () => {
    const text = Array.from({ length: 350 }, (_, index) => "x " + "`".repeat(index + 1)).join(" ");
    const start = performance.now();
    expect(extractLinks(text + " [[Home]]").map(({ target }) => target)).toEqual(["Home"]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("leaves reference links and autolinks unsupported, and preserves external destinations", () => {
    expect(
      extractLinks("[reference][id] <https://example.com> [url](https://example.com/a?q=1#h)").map(
        ({ target }) => target,
      ),
    ).toEqual(["https://example.com/a?q=1#h"]);
  });
});

describe("vault link resolution", () => {
  it("resolves adjacent notes first, then vault-root paths and unique shortest names", () => {
    expect(resolve("Note")).toMatchObject({
      status: "resolved",
      file: { path: "Projects/Note.md" },
    });
    expect(resolve("Home.md")).toMatchObject({ status: "resolved", file: { path: "Home.md" } });
    expect(resolve("Archive/Only Note")).toMatchObject({
      status: "resolved",
      file: { path: "Archive/Only Note.md" },
    });
    expect(resolve("Only%20Note")).toMatchObject({
      status: "resolved",
      target: "Only Note",
      file: { path: "Archive/Only Note.md" },
    });
    expect(resolve("image.png")).toMatchObject({
      status: "resolved",
      file: { path: "Assets/image.png", kind: "blob" },
    });
    expect(resolve("image")).toMatchObject({ status: "missing" });
  });

  it("prefers vault-root qualified paths before source-relative qualified paths", () => {
    const snapshot = [file("Folder/Target.md"), file("Projects/Folder/Target.md")];
    expect(resolve("Folder/Target", "Projects/Source.md", snapshot)).toMatchObject({
      status: "resolved",
      file: { path: "Folder/Target.md" },
    });
    expect(resolve("./Folder/Target", "Projects/Source.md", snapshot)).toMatchObject({
      status: "resolved",
      file: { path: "Projects/Folder/Target.md" },
    });
  });

  it("honors strict relative and root paths without shortest-name fallback", () => {
    expect(resolve("./Note.md")).toMatchObject({
      status: "resolved",
      file: { path: "Projects/Note.md" },
    });
    expect(resolve("../Note")).toMatchObject({ status: "resolved", file: { path: "Note.md" } });
    expect(resolve("/Note")).toMatchObject({ status: "resolved", file: { path: "Note.md" } });
    expect(resolve("./Only Note")).toMatchObject({ status: "missing", reason: "not-found" });
    expect(resolve("/Only Note")).toMatchObject({ status: "missing", reason: "not-found" });
  });

  it("returns all ambiguous matches in stable path order", () => {
    expect(resolve("Shared")).toMatchObject({
      status: "ambiguous",
      candidates: [{ path: "Archive/Shared.md" }, { path: "Other/Shared.md" }],
    });
    expect(resolve("Shared", "Projects/Source.md", [...files].reverse())).toEqual(
      resolve("Shared"),
    );
  });

  it("uses unique folder suffixes when a shortest path disambiguates names", () => {
    expect(
      resolve("Sub/Target", "Home.md", [file("One/Sub/Target.md"), file("Two/Target.md")]),
    ).toMatchObject({ status: "resolved", file: { path: "One/Sub/Target.md" } });
  });

  it("keeps decoded headings, nested headings and block subpaths without validating content", () => {
    expect(resolve("Home.md#Hello%20world#Nested")).toMatchObject({
      status: "resolved",
      subpath: "#Hello world#Nested",
      heading: "Hello world#Nested",
    });
    expect(resolve("Home#%5Eblock-id")).toMatchObject({
      status: "resolved",
      subpath: "#^block-id",
      blockId: "block-id",
    });
    expect(resolve("#Local%20heading")).toMatchObject({
      status: "resolved",
      file: { path: "Projects/Source.md" },
      heading: "Local heading",
    });
    expect(resolve("#^local-block")).toMatchObject({
      status: "resolved",
      file: { path: "Projects/Source.md" },
      blockId: "local-block",
    });
  });

  it("accepts extracted links and resolves NFC/case-normalized paths", () => {
    const [link] = extractLinks("[[note#heading|Name]]");
    expect(link && resolveLink(link, "Projects/Source.md", files)).toMatchObject({
      status: "resolved",
      file: { path: "Projects/Note.md" },
      heading: "heading",
    });
    expect(resolve("CAFÉ", "Home.md", [file("cafe\u0301.md")])).toMatchObject({
      status: "resolved",
    });
  });

  it.each([
    "https://example.com/a#b",
    "http://example.com",
    "mailto:a@example.com",
    "obsidian://open?vault=x",
    "file:///etc/passwd",
    "//example.com/x",
    "https%3A%2F%2Fexample.com",
  ])("classifies external target %s without fetching", (target) => {
    expect(resolve(target)).toMatchObject({ status: "external" });
  });

  it.each(["../../Home.md", "/../Home.md", "%2e%2e/%2e%2e/Home.md", "folder/../../../Home.md"])(
    "rejects attempts to escape the vault: %s",
    (target) => {
      expect(resolve(target)).toMatchObject({ status: "missing", reason: "outside-vault" });
    },
  );

  it.each(["bad%ZZ", "bad%00.md", "..\\Home.md", "bad?.md", ".private/file.md"])(
    "rejects invalid vault targets: %s",
    (target) => {
      expect(resolve(target)).toMatchObject({ status: "missing", reason: "invalid-target" });
    },
  );

  it("normalizes contained dot segments and never decodes a target twice", () => {
    expect(resolve("./folder/../Note")).toMatchObject({
      status: "resolved",
      file: { path: "Projects/Note.md" },
    });
    expect(resolve("%252e%252e/Home.md")).toMatchObject({ status: "missing", reason: "not-found" });
  });

  it("returns missing for a dangling link or absent source for a fragment", () => {
    expect(resolve("Absent#Heading")).toEqual({
      status: "missing",
      target: "Absent#Heading",
      heading: "Heading",
      subpath: "#Heading",
      reason: "not-found",
    });
    expect(resolve("#Heading", "Deleted.md")).toMatchObject({
      status: "missing",
      reason: "not-found",
    });
  });
});
