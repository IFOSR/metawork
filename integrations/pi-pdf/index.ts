// Derived from @joemccann/pi-pdf 1.0.1 (MIT); see UPSTREAM.md.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runPdfProcess } from "./process.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the package root for script paths
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------
  // Tool: pdf_info — Quick metadata and page count for a PDF
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "pdf_info",
    label: "PDF Info",
    description:
      "Get metadata and page count for a PDF file. Returns title, author, subject, creator, producer, page count, encryption status, and whether the PDF has fillable form fields.",
    promptSnippet: "Get PDF metadata, page count, encryption and form-field status",
    promptGuidelines: [
      "Use pdf_info as a first step when working with PDFs to understand what you're dealing with.",
      "Check the has_fillable_fields flag before deciding how to fill a PDF form.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the PDF file" }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pdfPath = resolve(ctx.cwd, params.path.replace(/^@/, ""));

      const script = `
import json, sys
from pypdf import PdfReader

try:
    reader = PdfReader(${JSON.stringify(pdfPath)})
    meta = reader.metadata or {}
    fields = reader.get_fields()
    info = {
        "path": ${JSON.stringify(pdfPath)},
        "pages": len(reader.pages),
        "encrypted": reader.is_encrypted,
        "has_fillable_fields": bool(fields),
        "fillable_field_count": len(fields) if fields else 0,
        "title": str(meta.get("/Title", "") or ""),
        "author": str(meta.get("/Author", "") or ""),
        "subject": str(meta.get("/Subject", "") or ""),
        "creator": str(meta.get("/Creator", "") or ""),
        "producer": str(meta.get("/Producer", "") or ""),
    }
    print(json.dumps(info))
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
`;

      const result = await runPdfProcess(["-c", script], { signal, onUpdate: _onUpdate, path: pdfPath });

      if (result.code !== 0) {
        throw new Error(
          `Failed to read PDF info: ${result.stderr || result.stdout}`
        );
      }

      const info = JSON.parse(result.stdout.trim());
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        details: info,
      };
    },
  });

  // -------------------------------------------------------------------
  // Tool: pdf_extract_text — Extract text from PDF pages
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "pdf_extract_text",
    label: "PDF Extract Text",
    description:
      "Extract text content from a PDF file. Can extract from all pages or specific page ranges. Uses pdfplumber for high-quality extraction with layout preservation.",
    promptSnippet: "Extract text from PDF pages with layout preservation",
    promptGuidelines: [
      "Use pdf_extract_text for reading PDF content. Specify page ranges to avoid extracting huge documents entirely.",
      "For table extraction, use pdf_extract_tables instead.",
      "Empty or unreliable text needs pdf_to_images followed by read on the returned PNG paths; never treat empty text as an empty document.",
      "For invoices prefer provided XML when available; deduplicate invoice numbers, preserve page/source references, use decimal amounts, and flag uncertain fields.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the PDF file" }),
      pages: Type.Optional(
        Type.String({
          description:
            'Page range to extract, e.g. "1-5", "1,3,5", "2-" (from page 2 to end). Omit only for documents of at most 5 pages.',
        })
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pdfPath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const pages = params.pages || "";

      const script = `
import json, sys
import pdfplumber

def parse_pages(spec, total):
    if not spec:
        if total > 5:
            raise ValueError("Specify pages: at most 5 pages per call; total_pages=" + str(total))
        return list(range(total))
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            parts = part.split("-", 1)
            start = int(parts[0]) - 1 if parts[0] else 0
            end = int(parts[1]) - 1 if parts[1] else total - 1
            if start < 0 or end >= total or start > end or end - start >= 5:
                raise ValueError("Invalid or oversized page range")
            pages.update(range(start, end + 1))
        else:
            p = int(part) - 1
            if p < 0 or p >= total:
                raise ValueError("Invalid page number")
            pages.add(p)
    if not pages or len(pages) > 5:
        raise ValueError("Specify 1 to 5 valid pages per call")
    return sorted(pages)

try:
    with pdfplumber.open(${JSON.stringify(pdfPath)}) as pdf:
        page_indices = parse_pages(${JSON.stringify(pages)}, len(pdf.pages))
        results = []
        for i in page_indices:
            print("PDF_PROGRESS:processing page " + str(i + 1), file=sys.stderr, flush=True)
            page = pdf.pages[i]
            text = page.extract_text() or ""
            results.append({"page": i + 1, "text": text})
        print(json.dumps({"pages": results, "total_pages": len(pdf.pages)}))
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
`;

      const result = await runPdfProcess(["-c", script], { signal, onUpdate: _onUpdate, path: pdfPath });

      if (result.code !== 0) {
        throw new Error(
          `Failed to extract text: ${result.stderr || result.stdout}`
        );
      }

      const data = JSON.parse(result.stdout.trim());
      let output = `Total pages: ${data.total_pages}\n`;
      for (const page of data.pages) {
        output += `\n--- Page ${page.page} ---\n${page.text}\n`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: data,
      };
    },
  });

  // -------------------------------------------------------------------
  // Tool: pdf_extract_tables — Extract tables from PDF
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "pdf_extract_tables",
    label: "PDF Extract Tables",
    description:
      "Extract tables from a PDF file. Returns structured table data from specified pages using pdfplumber. Outputs tables as arrays of rows.",
    promptSnippet: "Extract structured table data from PDF pages",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the PDF file" }),
      pages: Type.Optional(
        Type.String({
          description:
            'Page range, e.g. "1-5", "1,3,5". Omit only for documents of at most 5 pages.',
        })
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pdfPath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const pages = params.pages || "";

      const script = `
import json, sys
import pdfplumber

def parse_pages(spec, total):
    if not spec:
        if total > 5:
            raise ValueError("Specify pages: at most 5 pages per call; total_pages=" + str(total))
        return list(range(total))
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            parts = part.split("-", 1)
            start = int(parts[0]) - 1 if parts[0] else 0
            end = int(parts[1]) - 1 if parts[1] else total - 1
            if start < 0 or end >= total or start > end or end - start >= 5:
                raise ValueError("Invalid or oversized page range")
            pages.update(range(start, end + 1))
        else:
            p = int(part) - 1
            if p < 0 or p >= total:
                raise ValueError("Invalid page number")
            pages.add(p)
    if not pages or len(pages) > 5:
        raise ValueError("Specify 1 to 5 valid pages per call")
    return sorted(pages)

try:
    with pdfplumber.open(${JSON.stringify(pdfPath)}) as pdf:
        page_indices = parse_pages(${JSON.stringify(pages)}, len(pdf.pages))
        all_tables = []
        for i in page_indices:
            print("PDF_PROGRESS:processing page " + str(i + 1), file=sys.stderr, flush=True)
            page = pdf.pages[i]
            tables = page.extract_tables()
            for j, table in enumerate(tables):
                if table:
                    all_tables.append({
                        "page": i + 1,
                        "table_index": j,
                        "rows": table,
                        "row_count": len(table),
                        "col_count": len(table[0]) if table else 0
                    })
        print(json.dumps({"tables": all_tables, "total_tables": len(all_tables)}))
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
`;

      const result = await runPdfProcess(["-c", script], { signal, onUpdate: _onUpdate, path: pdfPath });

      if (result.code !== 0) {
        throw new Error(
          `Failed to extract tables: ${result.stderr || result.stdout}`
        );
      }

      const data = JSON.parse(result.stdout.trim());
      let output = `Found ${data.total_tables} table(s)\n`;
      for (const table of data.tables) {
        output += `\n--- Page ${table.page}, Table ${table.table_index + 1} (${table.row_count} rows × ${table.col_count} cols) ---\n`;
        for (const row of table.rows) {
          output += row.map((c: string | null) => c ?? "").join(" | ") + "\n";
        }
      }

      return {
        content: [{ type: "text", text: output }],
        details: data,
      };
    },
  });

  // -------------------------------------------------------------------
  // Tool: pdf_to_images — Convert PDF pages to images
  // -------------------------------------------------------------------
  pi.registerTool({
    name: "pdf_to_images",
    label: "PDF to Images",
    description:
      "Convert PDF pages to PNG images. Use the existing read tool on each returned PNG to inspect it with the current vision model. No Quick Look or sips is required.",
    promptSnippet: "Convert PDF pages to PNG images for visual analysis",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the PDF file" }),
      output_dir: Type.String({
        description: "Directory to save images into",
      }),
      dpi: Type.Optional(
        Type.Number({ description: "Resolution in DPI. Default: 200" })
      ),
      pages: Type.Optional(
        Type.String({
          description: 'Page range, e.g. "1-3". Omit only for documents of at most 5 pages.',
        })
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pdfPath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
      const outputDir = resolve(ctx.cwd, params.output_dir.replace(/^@/, ""));
      const dpi = params.dpi ?? 200;
      const pages = params.pages || "";

      const result = await runPdfProcess(
        [
          resolve(SCRIPTS_DIR, "convert_pdf_to_images.py"),
          pdfPath,
          outputDir,
          pages,
          String(dpi),
        ],
        { signal, onUpdate: _onUpdate, path: pdfPath, outputDir, cwd: ctx.cwd }
      );

      if (result.code !== 0) {
        throw new Error(
          `Failed to convert PDF to images: ${result.stderr || result.stdout}`
        );
      }

      return {
        content: [{ type: "text", text: result.stdout.trim() }],
        details: { output_dir: outputDir, dpi },
      };
    },
  });

}
