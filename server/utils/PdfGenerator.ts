import { PDFOptions } from "puppeteer";
import { trace } from "@server/logging/tracing";
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

        // Generate HTML from the document
        const html = await DocumentHelper.toHTML(document, {
            centered: true,
            includeMermaid: true,
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

            // Set content with full HTML
            await page.setContent(this.wrapHtmlForPdf(html), {
                waitUntil: "networkidle0",
            });

            // Calculate page numbers for each heading
            await this.injectPageNumbers(page);

            // Generate PDF with specific options
            const pdfOptions: PDFOptions = {
                format: "A4",
                printBackground: true,
                displayHeaderFooter: true,
                headerTemplate: '<div></div>',
                footerTemplate: `
                    <div style="width: 100%; font-size: 11px; padding: 0 15mm 0 0; margin: 0; box-sizing: border-box;">
                        <div style="text-align: right; color: #6b7280;">
                            <span class="pageNumber"></span>
                        </div>
                    </div>
                `,
                margin: {
                    top: "25mm",
                    right: "20mm",
                    bottom: "25mm",
                    left: "20mm",
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
     * Wrap HTML content with proper styling for PDF export
     */
    private static wrapHtmlForPdf(content: string): string {
        return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            @page {
              margin: 0;
            }
            
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
                'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
                sans-serif;
              font-size: 16px;
              line-height: 1.5;
              color: #1f2937;
              margin: 0;
              padding: 0;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }

            article {
              max-width: 100%;
              padding: 0;
            }

            h1, h2, h3, h4, h5, h6 {
              font-weight: 500;
              line-height: 1.25;
              margin-top: 1em;
              margin-bottom: 0.5em;
              page-break-after: avoid;
              break-after: avoid;
            }

            h1 { font-size: 36px; }
            h2 { font-size: 26px; }
            h3 { font-size: 20px; }
            h4 { font-size: 18px; }
            h5 { font-size: 16px; }
            h6 { font-size: 14px; }

            p, blockquote, pre, ul, ol, dl, table, figure {
              page-break-inside: avoid;
              break-inside: avoid;
            }

            img {
              max-width: 100%;
              height: auto;
              page-break-inside: avoid;
              break-inside: avoid;
            }

            pre {
              background: #f3f4f6;
              padding: 1em;
              border-radius: 4px;
              overflow-x: auto;
            }

            code {
              background: #f3f4f6;
              padding: 0.2em 0.4em;
              border-radius: 3px;
              font-family: 'Monaco', 'Courier New', monospace;
              font-size: 0.9em;
            }

            pre code {
              background: none;
              padding: 0;
            }

            blockquote {
              border-left: 3px solid #d1d5db;
              padding-left: 1em;
              margin-left: 0;
              color: #6b7280;
            }

            table {
              border-collapse: collapse;
              width: 100%;
              margin: 1em 0;
            }

            th, td {
              border: 1px solid #d1d5db;
              padding: 0.5em;
              text-align: left;
            }

            th {
              background: #f3f4f6;
              font-weight: 600;
            }

            a {
              color: #2563eb;
              text-decoration: underline;
            }

            ul, ol {
              padding-left: 2em;
            }

            li {
              margin: 0.5em 0;
            }
          </style>
        </head>
        <body>
          ${content}
        </body>
      </html>
    `;
    }
}
