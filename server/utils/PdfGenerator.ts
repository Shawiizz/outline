import { PDFOptions } from "puppeteer";
import katex from "katex";
import { JSDOM } from "jsdom";
import { codeToHtml } from "shiki";
import { trace } from "@server/logging/tracing";
import Logger from "@server/logging/Logger";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import Document from "@server/models/Document";

@trace()
export class PdfGenerator {
  /**
   * Generate a PDF from a document using Puppeteer
   * @param document The document to convert to PDF
   * @returns Buffer containing the PDF data
   */
  public static async generatePDF(document: Document): Promise<Buffer> {
    let puppeteer;

    try {
      // Import puppeteer dynamically to avoid issues if not installed
      puppeteer = require("puppeteer");
    } catch (error) {
      throw new Error(
        "Puppeteer is not installed. Run: npm install puppeteer"
      );
    }

    // Generate HTML from the document with signed URLs for images (valid for 5 minutes)
    const html = await DocumentHelper.toHTML(document, {
      centered: true,
      includeMermaid: true,
      includeStyles: true,
      includeHead: true,
      signedUrls: 300, // 5 minutes validity for signed attachment URLs
    });

    // Launch browser in headless mode
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    try {
      const page = await browser.newPage();

      // Render LaTeX math equations server-side and syntax highlight code
      const htmlWithRenderedMath = await this.renderMathServerSide(html);

      // Set content with full HTML
      await page.setContent(htmlWithRenderedMath, {
        waitUntil: "networkidle0",
        timeout: 180000, // 3 minutes timeout for documents with many images
      });

      // Calculate page numbers for each heading
      await this.injectPageNumbers(page);

      // Generate PDF with specific options
      const pdfOptions: PDFOptions = {
        format: "A4",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div style="width: 100%; font-size: 1px; padding: 0; margin: 0;">&nbsp;</div>',
        footerTemplate: `
                    <div style="width: 100%; font-size: 14px; padding: 0 15mm 0 0; margin: 0; box-sizing: border-box;">
                        <div style="text-align: right; color: #6b7280;">
                            <span class="pageNumber"></span> / <span class="totalPages"></span>
                        </div>
                    </div>
                `,
        margin: {
          top: "15mm",
          right: "0mm",
          bottom: "25mm",
          left: "0mm",
        },
      };

      const pdfBuffer = await page.pdf(pdfOptions);

      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
    }
  }

  /**
   * Inject real page numbers into the table of contents
   */
  private static async injectPageNumbers(page: any): Promise<void> {
    await page.evaluate(() => {
      // Get all TOC links
      const tocLinks = document.querySelectorAll('.document-toc a');

      if (tocLinks.length === 0) {
        return;
      }

      // Page dimensions (A4 with margins)
      const pageHeight = 297 - 25 - 25; // A4 height minus top/bottom margins in mm
      const mmToPx = 3.7795; // Conversion factor
      const pageHeightPx = pageHeight * mmToPx;

      tocLinks.forEach((link: any) => {
        const href = link.getAttribute('href');
        if (!href || !href.startsWith('#')) {
          return;
        }

        const targetId = href.substring(1);
        const targetElement = document.getElementById(targetId);

        if (targetElement) {
          // Calculate which page this element is on
          const elementTop = targetElement.getBoundingClientRect().top + window.scrollY;
          const pageNumber = Math.floor(elementTop / pageHeightPx) + 1;

          // Find the page number span in this link
          const pageSpan = link.querySelector('.toc-page-number');
          if (pageSpan) {
            pageSpan.textContent = pageNumber.toString();
          }
        }
      });
    });
  }

  /**
   * Render LaTeX math equations server-side with KaTeX and syntax highlight code blocks
   */
  private static async renderMathServerSide(html: string): Promise<string> {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Render inline math (math-node for inline)
    const inlineMathElements = document.querySelectorAll('math-inline');
    inlineMathElements.forEach((el) => {
      try {
        const latex = el.textContent || '';
        const rendered = katex.renderToString(latex, {
          throwOnError: false,
          displayMode: false,
        });
        const span = document.createElement('span');
        span.className = 'math-inline-rendered';
        span.innerHTML = rendered;
        el.replaceWith(span);
      } catch (e) {
        Logger.error('PDF: KaTeX inline render error', e);
      }
    });

    // Render display math (math-node for display)
    const displayMathElements = document.querySelectorAll('math-display');
    displayMathElements.forEach((el) => {
      try {
        const latex = el.textContent || '';
        const rendered = katex.renderToString(latex, {
          throwOnError: false,
          displayMode: true,
        });
        const div = document.createElement('div');
        div.className = 'math-display-rendered';
        div.innerHTML = rendered;
        el.replaceWith(div);
      } catch (e) {
        Logger.error('PDF: KaTeX display render error', e);
      }
    });

    // Syntax highlight code blocks with shiki
    const codeBlocks = document.querySelectorAll('.code-block');
    for (const block of Array.from(codeBlocks)) {
      try {
        const codeElement = block.querySelector('code');
        if (!codeElement) continue;

        const code = codeElement.textContent || '';
        const language = block.getAttribute('data-language') || 'text';

        // Use shiki to render syntax-highlighted HTML (without background)
        const highlighted = await codeToHtml(code, {
          lang: language,
          theme: 'github-light',
          transformers: [
            {
              pre(node) {
                // Remove background from pre tag
                if (node.properties.style) {
                  node.properties.style = (node.properties.style as string).replace(/background-color:[^;]+;?/g, '');
                }
              }
            }
          ]
        });

        // Replace the entire code block with highlighted version
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = highlighted;
        const highlightedPre = tempDiv.querySelector('pre');

        if (highlightedPre) {
          // Preserve the code-block class for styling
          highlightedPre.classList.add('code-block');
          highlightedPre.setAttribute('data-language', language);
          block.replaceWith(highlightedPre);
        }
      } catch (e) {
        Logger.error('PDF: Shiki syntax highlight error', e);
        // Keep original block if highlighting fails
      }
    }

    // Add KaTeX CSS and code block syntax highlighting to head
    const head = document.querySelector('head');
    if (head) {
      // KaTeX CSS
      const katexLink = document.createElement('link');
      katexLink.rel = 'stylesheet';
      katexLink.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css';
      katexLink.integrity = 'sha384-n8MVd4RsNIU0tAv4ct0nTaAbDJwPJzDEaqSD1odI+WdtXRGWt2kTvGFasHpSy3SV';
      katexLink.crossOrigin = 'anonymous';
      head.appendChild(katexLink);

      // Add custom CSS for margins and code blocks
      const style = document.createElement('style');
      style.textContent = `
        @page {
          margin: 15mm 20mm 25mm 20mm;
        }
        .math-display-rendered {
          margin: 1em 0;
          text-align: center;
        }

        /* Shiki-generated code blocks - remove shiki background, use our own */
        pre.shiki, pre[class*="shiki"] {
          background: transparent !important;
          padding: 16px !important;
          border-radius: 6px !important;
          margin: 1em 0 !important;
          overflow-x: auto !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        /* Shiki code styling */
        pre.shiki code, pre[class*="shiki"] code {
          background: transparent !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        /* Fallback for non-highlighted code blocks */
        .code-block, div.code-block {
          background: #f6f8fa !important;
          border: 1px solid #e1e4e8 !important;
          border-radius: 6px !important;
          padding: 0 !important;
          margin: 1em 0 !important;
          overflow: visible !important;
        }

        .code-block pre, pre {
          background: #f6f8fa !important;
          border-radius: 6px !important;
          padding: 16px !important;
          overflow-x: auto !important;
          margin: 0 !important;
          line-height: 1.45 !important;
        }

        .code-block pre code, pre code {
          color: #24292e !important;
          background: none !important;
          padding: 0 !important;
          font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace !important;
          font-size: 13px !important;
          line-height: 1.45 !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        /* Inline code styling - target explicit inline code class and common variations */
        code.inline, code[class*="inline"], .inline-code, code[data-inline="true"] {
          background: #EDF2FA !important;
          color: #0b3d91 !important; /* stronger blue for visibility */
          padding: 0.18em 0.36em !important;
          border-radius: 3px !important;
          font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace !important;
          font-size: 0.85em !important;
          font-weight: 500 !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        /* Fallback: any code not inside pre (catch-all) */
        :not(pre) code {
          background: #EDF2FA !important;
          color: #0b3d91 !important;
          padding: 0.18em 0.36em !important;
          border-radius: 3px !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
      `;
      head.appendChild(style);
    }

    return dom.serialize();
  }
}
