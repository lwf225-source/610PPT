import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import JSZip from "jszip";
import mammoth from "mammoth";

const deps = {};

export class DocumentInputError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DocumentInputError";
    this.code = code;
    this.statusCode = 422;
  }
}

export function configureDocuments(injected = {}) {
  Object.assign(deps, injected);
}

function extractPptxParagraphs(xml) {
  const paragraphs = [];
  const paragraphMatches = xml.match(/<a:p[\s\S]*?<\/a:p>/g) || [];
  for (const paragraphXml of paragraphMatches) {
    const runs = [...paragraphXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((match) => deps.decodeXmlText(match[1]))
      .join("")
      .trim();
    if (runs) paragraphs.push(runs);
  }
  return paragraphs;
}

async function readPptxText(fullPath) {
  try {
    const archive = await JSZip.loadAsync(await fs.readFile(fullPath));
    const slideEntries = Object.keys(archive.files)
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
      .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)?.[1] || 0) - Number(b.match(/slide(\d+)\.xml/)?.[1] || 0));

    if (!slideEntries.length) {
      throw new Error("PPTX 中没有找到 slide XML");
    }

    const sections = [];
    for (const [index, entry] of slideEntries.entries()) {
      const xml = await archive.file(entry).async("string");
      const paragraphs = extractPptxParagraphs(xml);
      const title = paragraphs.find((line) => line.length >= 2) || `Slide ${index + 1}`;
      sections.push([
        `## P${String(index + 1).padStart(2, "0")} ${title}`,
        "",
        ...paragraphs.slice(1).map((line) => `- ${line}`)
      ].join("\n"));
    }

    return {
      text: deps.normalizeExtractedText(sections.join("\n\n")),
      warnings: []
    };
  } catch (error) {
    throw new Error(`PPTX 解析失败：${error.message}`);
  }
}

async function readPdfTextWithPython(fullPath) {
  const warnings = [];
  const pdfPython = String.raw`
import sys
path = sys.argv[1]
parts = []
try:
    import pdfplumber
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            text = page.extract_text(layout=True) or page.extract_text() or ""
            parts.append(f"## Source PDF page {i}\n{text}" if text.strip() else "")
except Exception:
    from pypdf import PdfReader
    reader = PdfReader(path)
    for i, page in enumerate(reader.pages, 1):
        text = page.extract_text() or ""
        parts.append(f"## Source PDF page {i}\n{text}" if text.strip() else "")
print("\n\n".join(parts))
`;
  for (const python of deps.pythonCandidates()) {
    try {
      if (path.isAbsolute(python) && !deps.isExecutable(python)) continue;
      const { stdout, stderr } = await deps.execFileAsync(python, ["-c", pdfPython, fullPath], {
        maxBuffer: 80 * 1024 * 1024,
        timeout: 120000
      });
      if (stderr?.trim()) warnings.push(stderr.trim());
      const text = deps.normalizeExtractedText(stdout);
      if (text) return { text, warnings };
      warnings.push(`${path.basename(python)}: PDF 没有可读取的文字`);
    } catch (error) {
      warnings.push(`${path.basename(python)}: ${error.message}`);
    }
  }
  return { text: "", warnings };
}

async function readPdfTextWithPdfJs(fullPath) {
  let loadingTask;
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))), '../..');
    loadingTask = getDocument({
      data: new Uint8Array(await fs.readFile(fullPath)),
      disableWorker: true,
      useSystemFonts: false,
      ...pdfResourcePaths(pdfRoot),
      cMapPacked: true,
    });
    const document = await loadingTask.promise;
    const sections = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = [];
      let current = "";
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        current += `${current && item.str ? " " : ""}${item.str}`;
        if (item.hasEOL) {
          if (current.trim()) lines.push(current.trim());
          current = "";
        }
      }
      if (current.trim()) lines.push(current.trim());
      const pageText = lines.join("\n").trim();
      if (pageText) sections.push(`## Source PDF page ${pageNumber}\n${pageText}`);
    }
    const text = deps.normalizeExtractedText(sections.join("\n\n"));
    if (!text) throw new Error("PDF 没有可读取的文字，扫描件需要先执行 OCR");
    return text;
  } catch (error) {
    if (/扫描件需要先执行 OCR/.test(error.message)) throw error;
    throw new Error(`PDF 解析失败：${error.message}`);
  } finally {
    await loadingTask?.destroy().catch(() => {});
  }
}

export function pdfResourcePaths(root) {
  // PDF.js validates a literal trailing '/', while its Node factory passes
  // this string to fs.readFile. Windows accepts C:/ and //server/share paths;
  // file: URL strings and a trailing backslash are not accepted here.
  const base = root.replaceAll('\\', '/').replace(/\/+$/, '') + '/';
  return { cMapUrl: base + 'cmaps/', standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/' };
}

async function readPdfText(fullPath) {
  const python = process.env.PPT_WORKBENCH_DISABLE_PYTHON_PDF === "1"
    ? { text: "", warnings: ["Python PDF parser disabled"] }
    : await readPdfTextWithPython(fullPath);
  if (python.text) return python;
  const text = await readPdfTextWithPdfJs(fullPath);
  return {
    text,
    warnings: ["包内 Python 解析器不可用，已自动切换到内置 PDF 兼容解析器。"]
  };
}

async function readLegacyDocText(fullPath) {
  const warnings = [];
  const tempDir = path.join(deps.DATA_DIR, "tmp", `doc-convert-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    for (const [candidateIndex, soffice] of deps.sofficeCandidates().entries()) {
      try {
        if (path.isAbsolute(soffice) && !deps.isExecutable(soffice)) continue;
        const profileDir = path.join(tempDir, `libreoffice-profile-${candidateIndex}`);
        await fs.mkdir(profileDir, { recursive: true });
        await deps.execFileAsync(soffice, [
          `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
          "--headless",
          "--nologo",
          "--nodefault",
          "--nofirststartwizard",
          "--convert-to",
          "docx",
          "--outdir",
          tempDir,
          fullPath
        ], {
          maxBuffer: 20 * 1024 * 1024,
          timeout: 60000
        });
        const convertedName = (await fs.readdir(tempDir)).find((name) => name.toLowerCase().endsWith(".docx"));
        if (!convertedName) throw new Error("没有生成 docx 文件");
        const convertedPath = path.join(tempDir, convertedName);
        const result = await mammoth.extractRawText({ path: convertedPath });
        return {
          text: result.value,
          warnings: [
            "旧 .doc 已临时转换为 .docx 后解析",
            ...warnings,
            ...(result.messages?.map((message) => message.message) ?? [])
          ]
        };
      } catch (error) {
        warnings.push(`${path.basename(soffice)}: ${error.message}`);
      }
    }

    for (const [candidateIndex, textutil] of deps.textutilCandidates().entries()) {
      try {
        if (path.isAbsolute(textutil) && !deps.isExecutable(textutil)) continue;
        const outputPath = path.join(tempDir, `textutil-${candidateIndex}.txt`);
        await deps.execFileAsync(textutil, [
          "-convert",
          "txt",
          "-encoding",
          "UTF-8",
          "-output",
          outputPath,
          fullPath
        ], {
          maxBuffer: 20 * 1024 * 1024,
          timeout: 60000
        });
        const text = deps.normalizeExtractedText((await fs.readFile(outputPath, "utf8"))
          .replace(/\bHYPERLINK\s+(?:\\l\s+)?"[^"]*"(?:\s+\\o\s+"[^"]*")?\s*/g, ""));
        if (!text) throw new Error("没有提取到可读文字");
        return {
          text,
          warnings: [
            "旧 .doc 已通过 macOS textutil 解析",
            ...warnings
          ]
        };
      } catch (error) {
        warnings.push(`${path.basename(textutil)}: ${error.message}`);
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  throw new Error(`DOC 解析失败：旧 .doc 转换失败。${warnings.slice(-3).join("；")}`);
}

export async function readSource(relPath) {
  // 存储路径可能带 @data/ 前缀（数据目录外置到 Application Support），
  // 必须走 resolveStoredPath 统一解析，不能直接拼 PROJECT_ROOT。
  const fullPath = deps.resolveStoredPath(relPath);
  const ext = path.extname(fullPath).toLowerCase();
  if (!deps.SOURCE_EXTS.has(ext)) {
    throw new DocumentInputError(
      `不支持${ext ? ` ${ext} 格式的` : "此格式的"}源文档，请转换为 ${[...deps.SOURCE_EXTS].join("、")} 后重新上传。`,
      "UNSUPPORTED_SOURCE_DOCUMENT_TYPE"
    );
  }
  deps.assertRealPathWithin(deps.storedPathBase(relPath), fullPath);

  if (ext === ".doc") {
    return await readLegacyDocText(fullPath);
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: fullPath });
    return {
      text: result.value,
      warnings: result.messages?.map((message) => message.message) ?? []
    };
  }

  if (ext === ".pptx") {
    return await readPptxText(fullPath);
  }

  if (ext === ".pdf") {
    return await readPdfText(fullPath);
  }

  return {
    text: await fs.readFile(fullPath, "utf8"),
    warnings: []
  };
}
