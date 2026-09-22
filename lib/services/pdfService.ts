import * as puppeteer from "puppeteer";
import { CHECKLIST_STATUS } from "../utils/enums/checklist";
import {
  DEFAULT_PHOTOS_PER_PAGE,
  PHOTO_CAPTION_FONT_SIZE,
  PHOTOS_PER_PAGE_GRID,
} from "../utils/constants/printPhotos";
import { IImagesPdfData, IImagesPdfFile } from "../utils/interfaces/files";

interface ChecklistPDFData {
  checklist: any;
  todoList: any[];
  user: any;
}

// User-supplied text (notes, names) is interpolated into the print template,
// so it must not be able to inject markup.
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export class PDFService {
  /**
   * Generate a PDF from pre-fetched checklist data (matching getChecklistDetailsV2 structure)
   */
  public static async generateChecklistPDFFromData(
    checklistData: any,
    user: any,
  ): Promise<Buffer> {
    try {
      // Validate input data
      if (!checklistData) {
        throw new Error("No checklist data provided");
      }

      // Prepare the data in the format expected by generateChecklistHTML
      const data: ChecklistPDFData = {
        checklist: checklistData,
        todoList: checklistData.todoList || [],
        user: user,
      };

      // Generate HTML content
      const html = this.generateChecklistHTML(data);

      // Validate HTML was generated
      if (!html || html.trim().length === 0) {
        throw new Error("Failed to generate HTML content");
      }

      // Convert HTML to PDF using Puppeteer
      return await this.convertHTMLtoPDF(html);
    } catch (error) {
      console.error("Error in generateChecklistPDFFromData:", error);
      throw error;
    }
  }

  /**
   * Generate HTML content for the checklist
   */
  private static generateChecklistHTML(data: ChecklistPDFData): string {
    const { checklist, todoList } = data;

    // Extract project and company info - they might be passed directly or in the checklist object
    const project = checklist.project || {};
    const company = checklist.company || {};

    // Calculate progress
    const totalTodos = todoList.length;
    const completedTodos = todoList.filter(
      (todo) => todo.status === CHECKLIST_STATUS.COMPLETED,
    ).length;
    const progressPercentage =
      totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0;

    // Format date
    const formatDate = (date: Date | string) => {
      if (!date) return "N/A";
      const d = new Date(date);
      return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    };

    // Generate todo items HTML
    const todoItemsHTML = todoList
      .map((todo: any, index: number) => {
        const statusIcon =
          todo.status === CHECKLIST_STATUS.COMPLETED ? "✓" : "○";

        const statusClass =
          todo.status === CHECKLIST_STATUS.COMPLETED ? "completed" : "pending";

        // Handle questions if they exist
        const questionsHTML =
          todo.questions && todo.questions.length > 0
            ? `
          <div class="questions">
            <strong>Questions:</strong>
            <ul>
              ${todo.questions
                .map(
                  (q: any) => `
                <li>
                  <span class="question-label">${q.label}:</span>
                  <span class="question-value">${q.value || "Not answered"}</span>
                </li>
              `,
                )
                .join("")}
            </ul>
          </div>
        `
            : "";

        // Handle task images (from taskImages field)
        const taskImagesHTML =
          todo.taskImages && todo.taskImages.length > 0
            ? `
          <div class="task-images">
            <strong>Task Images:</strong>
            <div class="image-grid">
              ${todo.taskImages
                .map((img: any) => {
                  const imageUrl = img.imageData?.url || img.url || "";
                  if (!imageUrl) return "";
                  return `
                  <div class="image-container">
                    <img src="${imageUrl}" alt="Task image" />
                  </div>
                `;
                })
                .join("")}
            </div>
          </div>
        `
            : "";

        // Handle uploaded images (from images array - todo list images)
        const uploadedImagesHTML =
          todo.images && todo.images.length > 0
            ? `
          <div class="task-images">
            <strong>Uploaded Images:</strong>
            <div class="image-grid">
              ${todo.images
                .map((img: any) => {
                  const imageUrl = img.imageData?.url || img.url || "";
                  if (!imageUrl) return "";
                  return `
                  <div class="image-container">
                    <img src="${imageUrl}" alt="Uploaded image" />
                  </div>
                `;
                })
                .join("")}
            </div>
          </div>
        `
            : "";

        // Handle post images if post exists
        const postImagesHTML =
          todo.postImages && todo.postImages.length > 0
            ? `
          <div class="task-images">
            <strong>Post Images:</strong>
            <div class="image-grid">
              ${todo.postImages
                .map((img: any) => {
                  const imageUrl = img.url || "";
                  if (!imageUrl) return "";
                  return `
                  <div class="image-container">
                    <img src="${imageUrl}" alt="Post image" />
                  </div>
                `;
                })
                .join("")}
            </div>
          </div>
        `
            : "";

        // Get completed by name from aggregation
        const completedByName =
          todo.completedBy?.userName ||
          (todo.completedBy?.firstName && todo.completedBy?.lastName
            ? `${todo.completedBy.firstName} ${todo.completedBy.lastName}`
            : "");

        return `
        <div class="todo-item ${statusClass}">
          <div class="todo-header">
            <span class="todo-number">${index + 1}.</span>
            <span class="status-icon">${statusIcon}</span>
            <span class="todo-name">${todo.name}</span>
          </div>
          ${todo.description ? `<div class="todo-description">${todo.description}</div>` : ""}
          ${questionsHTML}
          ${
            todo.status === CHECKLIST_STATUS.COMPLETED && completedByName
              ? `
            <div class="completion-info">
              Completed by: ${completedByName}
              on ${formatDate(todo.completedAt)}
            </div>
          `
              : ""
          }
          ${taskImagesHTML}
          ${uploadedImagesHTML}
          ${postImagesHTML}
        </div>
      `;
      })
      .join("");

    // Generate complete HTML document
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${checklist.name} - Checklist</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            color: #333;
            line-height: 1.6;
            padding: 20px;
          }

          .header {
            background: linear-gradient(135deg, #0BB089 0%, #0BB089 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 30px;
          }

          .header h1 {
            font-size: 28px;
            margin-bottom: 10px;
          }

          .header .subtitle {
            font-size: 16px;
            opacity: 0.9;
          }

          .info-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            margin-bottom: 30px;
          }

          .info-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            border-left: 4px solid #0BB089;
          }

          .info-card h3 {
            color: #0BB089;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
          }

          .info-card p {
            font-size: 16px;
            color: #333;
          }

          .progress-section {
            background: #fff;
            padding: 25px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            margin-bottom: 30px;
          }

          .progress-bar {
            background: #e9ecef;
            height: 30px;
            border-radius: 15px;
            overflow: hidden;
            margin: 15px 0;
          }

          .progress-fill {
            background: linear-gradient(90deg, #0BB089 0%, #0BB089 100%);
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            transition: width 0.3s ease;
          }

          .todos-section {
            background: white;
            padding: 25px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }

          .todos-section h2 {
            color: #333;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 2px solid #e9ecef;
          }

          .todo-item {
            padding: 20px;
            margin-bottom: 15px;
            border-radius: 8px;
            border: 1px solid #e9ecef;
            page-break-inside: avoid;
          }

          .todo-item.completed {
            background: #f0fff4;
            border-color: #48bb78;
          }

          .todo-item.in-progress {
            background: #fff5f0;
            border-color: #ed8936;
          }

          .todo-item.pending {
            background: #fafafa;
            border-color: #cbd5e0;
          }

          .todo-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
          }

          .todo-number {
            font-weight: bold;
            color: #0BB089;
          }

          .status-icon {
            font-size: 20px;
          }

          .todo-name {
            font-size: 18px;
            font-weight: 500;
          }

          .todo-description {
            margin-left: 50px;
            color: #666;
            margin-bottom: 10px;
          }

          .completion-info {
            margin-left: 50px;
            margin-top: 10px;
            padding: 10px;
            background: #e6fffa;
            border-radius: 5px;
            font-size: 14px;
            color: #065666;
          }

          .questions {
            margin-left: 50px;
            margin-top: 15px;
            padding: 15px;
            background: #f7fafc;
            border-radius: 5px;
          }

          .questions ul {
            list-style: none;
            margin-top: 10px;
          }

          .questions li {
            padding: 5px 0;
            border-bottom: 1px solid #e2e8f0;
          }

          .questions li:last-child {
            border-bottom: none;
          }

          .question-label {
            font-weight: 500;
            color: #4a5568;
          }

          .question-value {
            color: #2d3748;
            margin-left: 10px;
          }

          .task-images {
            margin-left: 50px;
            margin-top: 15px;
          }

          .image-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 10px;
          }

          .image-container {
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            overflow: hidden;
            page-break-inside: avoid;
          }

          .image-container img {
            width: 100%;
            height: auto;
            display: block;
          }

          .footer {
            margin-top: 40px;
            padding: 20px;
            text-align: center;
            color: #718096;
            font-size: 14px;
            border-top: 2px solid #e9ecef;
          }

          @media print {
            .header {
              background: #0BB089 !important;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }

            .todo-item {
              page-break-inside: avoid;
            }

            .image-container {
              page-break-inside: avoid;
            }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>${checklist.name}</h1>
          <div class="subtitle">
            ${project ? `Project: ${project.name}` : ""}
            ${company ? ` | ${company.name}` : ""}
          </div>
        </div>

        <div class="info-grid">
          <div class="info-card">
            <h3>Status</h3>
            <p>${checklist.completedTodo == checklist.totalTodo ? "Completed" : "In Progress"}</p>
          </div>
          <div class="info-card">
            <h3>Created</h3>
            <p>${formatDate(checklist.createdAt)}</p>
          </div>
          <div class="info-card">
            <h3>Generated By</h3>
            <p>${checklist.userName}</p>
          </div>
        </div>

        <div class="progress-section">
          <h2>Progress Overview</h2>
          <p>${completedTodos} of ${totalTodos} items completed</p>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progressPercentage}%">
              ${progressPercentage}%
            </div>
          </div>
        </div>

        <div class="todos-section">
          <h2>Checklist Items</h2>
          ${todoItemsHTML}
        </div>

        <div class="footer">
          <p>Generated on ${formatDate(new Date())}</p>
          <p>© ${new Date().getFullYear()} ${company ? company.name : "RelayCam"}</p>
        </div>
      </body>
      </html>
    `;
  }

  /**
   * Convert HTML to PDF using Puppeteer
   */
  private static async convertHTMLtoPDF(
    html: string,
    waitForImages = false,
  ): Promise<Buffer> {
    let browser = null;

    try {
      // Launch Puppeteer with specific options for better compatibility
      browser = await puppeteer.launch({
        headless: true,
        // Set in Docker to the system chromium; falls back to Puppeteer's
        // bundled Chrome locally.
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
        ignoreDefaultArgs: ["--disable-extensions"],
      });

      const page = await browser.newPage();

      // Set viewport for consistency
      await page.setViewport({
        width: 1200,
        height: 800,
      });

      // Set content and wait for it to load
      await page.setContent(html, {
        waitUntil: ["domcontentloaded", "load"],
      });

      // Additional wait to ensure all content is rendered
      await page.evaluate(() => {
        return new Promise((resolve) => {
          if (document.readyState === "complete") {
            setTimeout(resolve, 500);
          } else {
            window.addEventListener("load", () => setTimeout(resolve, 500));
          }
        });
      });

      // Pages built around remote images must not print before they decode;
      // capped so a single dead URL can't hang the request.
      //
      // Must stay free of async/await: the callback is serialized into the
      // browser, where TypeScript's downleveled __awaiter helper does not
      // exist (tsconfig targets es5).
      if (waitForImages) {
        await page.evaluate(() => {
          return new Promise((resolve) => {
            const pending: HTMLImageElement[] = [];
            for (let i = 0; i < document.images.length; i++) {
              if (!document.images[i].complete) {
                pending.push(document.images[i]);
              }
            }

            if (pending.length === 0) {
              return resolve(null);
            }

            let remaining = pending.length;
            const settle = () => {
              remaining -= 1;
              if (remaining <= 0) resolve(null);
            };

            pending.forEach((img) => {
              img.addEventListener("load", settle);
              img.addEventListener("error", settle);
            });

            setTimeout(() => resolve(null), 30000);
          });
        });
      }

      // Generate PDF
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        displayHeaderFooter: false,
        margin: {
          top: "20mm",
          right: "20mm",
          bottom: "20mm",
          left: "20mm",
        },
        preferCSSPageSize: false,
      });

      // Ensure we return a proper Buffer
      return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    } catch (error: any) {
      throw new Error(`Failed to generate PDF: ${error?.message || error}`);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  /**
   * Generate a PDF of selected post images, `photosPerPage` photos per page
   */
  public static async generateImagesPdfFromData(
    data: IImagesPdfData,
  ): Promise<Buffer> {
    const { imageData } = data;

    if (!imageData || imageData.length === 0) {
      throw new Error("No Images data provided");
    }

    const html = this.generateImagesHTML(data);

    if (!html || html.trim().length === 0) {
      throw new Error("Failed to generate HTML content");
    }

    // Remote S3 images must finish loading before the page is printed.
    return await this.convertHTMLtoPDF(html, true);
  }

  /**
   * Generate HTML content for the selected images. Photos are chunked into
   * fixed-height pages laid out as the cols x rows grid the client previewed,
   * so each printed page holds exactly `photosPerPage` photos regardless of
   * their aspect ratios.
   */
  private static generateImagesHTML(data: IImagesPdfData): string {
    const { imageData, includeFileDetails } = data;
    const projectAddress = escapeHtml(data.projectAddress?.trim() || "");
    const requested = Number(data.photosPerPage);
    const perPage = PHOTOS_PER_PAGE_GRID[requested]
      ? requested
      : DEFAULT_PHOTOS_PER_PAGE;
    const { cols, rows } = PHOTOS_PER_PAGE_GRID[perPage];
    const captionFontSize = PHOTO_CAPTION_FONT_SIZE[perPage];
    // Dense grids keep compact metadata, but the property address must wrap.
    const denseCaption = perPage >= 10;

    const formatDate = (date?: Date | string) => {
      if (!date) return "";
      return new Date(date).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    };

    // Chunk into pages of `perPage` photos
    const pages: IImagesPdfFile[][] = [];
    for (let i = 0; i < imageData.length; i += perPage) {
      pages.push(imageData.slice(i, i + perPage));
    }

    const pagesHTML = pages
      .map((page) => {
        const cardsHTML = page
          .map((file) => {
            const frameHTML = file.url
              ? `<img src="${escapeHtml(file.url)}" alt="Project photo" />`
              : `<span class="missing">Image unavailable</span>`;

            const takenBy = file.userName ? escapeHtml(file.userName) : "";
            // The file's own capture time wins; fall back through upload time
            // and the file's row date to the parent post's date.
            const takenAt = formatDate(
              file.timestamp ||
                file.uploadedAt ||
                file.createdAt ||
                file.postCreatedAt,
            );
            const location =
              file.location?.lat != null && file.location?.long != null
                ? `${Number(file.location.lat.toFixed(5))}, ${Number(file.location.long.toFixed(5))}`
                : "";
            const lines = [takenBy, takenAt, projectAddress, location].filter(
              Boolean,
            );

            const detailsHTML =
              includeFileDetails && lines.length
                ? denseCaption
                  ? projectAddress
                    ? `<div class="photo-details compact">
                        ${takenBy || takenAt ? `<div class="compact-meta">${[takenBy, takenAt].filter(Boolean).join(" &middot; ")}</div>` : ""}
                        <div class="sub address">${projectAddress}</div>
                        ${location ? `<div class="sub">${location}</div>` : ""}
                      </div>`
                    : `<div class="photo-details dense">${lines.join(" &middot; ")}</div>`
                  : `
              <div class="photo-details">
                ${takenBy ? `<div class="meta">${takenBy}</div>` : ""}
                ${takenAt ? `<div class="sub">${takenAt}</div>` : ""}
                ${projectAddress ? `<div class="sub address">${projectAddress}</div>` : ""}
                ${location ? `<div class="sub">${location}</div>` : ""}
              </div>
            `
                : "";

            return `
          <div class="photo-card">
            <div class="photo-frame">${frameHTML}</div>
            ${detailsHTML}
          </div>
        `;
          })
          .join("");

        return `<div class="page">${cardsHTML}</div>`;
      })
      .join("");

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>Photos</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            color: #333;
          }

          /* A4 (297mm) minus the 20mm top/bottom margins set in page.pdf().
             Fixed row heights (not auto) so a partial last page keeps the same
             photo size as the full pages before it. */
          .page {
            height: 257mm;
            display: grid;
            grid-template-columns: repeat(${cols}, 1fr);
            grid-auto-rows: calc((257mm - ${(rows - 1) * 4}mm) / ${rows});
            gap: 4mm;
            page-break-after: always;
          }

          .page:last-child {
            page-break-after: auto;
          }

          .photo-card {
            min-width: 0;
            min-height: 0;
            display: flex;
            flex-direction: column;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            overflow: hidden;
            page-break-inside: avoid;
          }

          .photo-frame {
            position: relative;
            flex: 1 1 auto;
            min-height: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            background: #f8f9fa;
          }

          /* Absolute + object-fit: a percentage max-height would not resolve
             against the frame's flex-derived height, letting tall photos
             overflow their slot. */
          .photo-frame img {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: contain;
            display: block;
          }

          .missing {
            color: #a0aec0;
            font-size: 13px;
          }

          .photo-details {
            flex: 0 0 auto;
            padding: 6px 10px;
            border-top: 1px solid #e2e8f0;
            background: #fff;
            font-size: ${captionFontSize}pt;
            line-height: 1.35;
          }

          /* Keep dense metadata compact while letting the address wrap. */
          .photo-details.dense,
          .photo-details.compact {
            padding: 3px 6px;
            color: #444;
          }

          .photo-details.dense,
          .photo-details .compact-meta {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .photo-details .address {
            overflow-wrap: anywhere;
            /* Oversized saved addresses must not consume the photo frame. */
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 6;
            overflow: hidden;
          }

          .photo-details .meta {
            color: #0BB089;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.04em;
          }

          .photo-details .sub {
            color: #666;
            font-size: ${Math.max(captionFontSize - 1, 5)}pt;
          }

          @media print {
            .photo-card {
              page-break-inside: avoid;
            }

            .photo-details {
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
          }
        </style>
      </head>
      <body>
        ${pagesHTML}
      </body>
      </html>
    `;
  }
}
