import type {
  IClinicalReportRenderer,
  RenderClinicalReportInput,
  RenderClinicalReportResult,
} from '../../../domain/healthcare/ports/IClinicalReportRenderer';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class PuppeteerClinicalReportRenderer implements IClinicalReportRenderer {
  async render(input: RenderClinicalReportInput): Promise<RenderClinicalReportResult> {
    // The browser stack is loaded on the first report, not when the process starts.
    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({ headless: true });

    try {
      const page = await browser.newPage();
      await page.setContent(this.buildHtml(input), { waitUntil: 'load' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true });

      return {
        fileName: `${input.caseId}-mri-second-opinion.pdf`,
        bytes: Buffer.from(pdf),
        mimeType: 'application/pdf',
      };
    } finally {
      await browser.close();
    }
  }

  private buildHtml(input: RenderClinicalReportInput): string {
    const safetyFlags = input.safetyFlags.length === 0
      ? '<li>No safety flags raised</li>'
      : input.safetyFlags
          .map(
            (flag) => `<li><strong>${escapeHtml(flag.flagCode)}</strong> [${escapeHtml(flag.severity)}] ${escapeHtml(flag.description)}${flag.blocksDelivery ? ' (blocks delivery)' : ''}</li>`,
          )
          .join('');

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #111827; }
      h1, h2 { margin-bottom: 8px; }
      .meta { margin-bottom: 24px; padding: 16px; background: #f3f4f6; border-radius: 8px; }
      .section { margin-top: 20px; }
      .label { font-weight: 700; }
      ul { padding-left: 20px; }
    </style>
  </head>
  <body>
    <h1>MRI Second Opinion Report</h1>
    <div class="meta">
      <div><span class="label">Case ID:</span> ${escapeHtml(input.caseId)}</div>
      <div><span class="label">Study UID:</span> ${escapeHtml(input.studyInstanceUid)}</div>
      <div><span class="label">Modality:</span> ${escapeHtml(input.modality)}</div>
      <div><span class="label">Body Part:</span> ${escapeHtml(input.bodyPartExamined)}</div>
      <div><span class="label">Urgency:</span> ${escapeHtml(input.urgency)}</div>
      <div><span class="label">Outcome:</span> ${escapeHtml(input.outcome)}</div>
      <div><span class="label">Model:</span> ${escapeHtml(input.modelId ?? 'not-recorded')}</div>
      <div><span class="label">Reviewer:</span> ${escapeHtml(input.reviewerRole ?? 'not-recorded')}</div>
      <div><span class="label">Review decision:</span> ${escapeHtml(input.reviewerDecision ?? 'not-recorded')}</div>
    </div>
    <div class="section">
      <h2>Clinical Question</h2>
      <p>${escapeHtml(input.clinicalQuestion)}</p>
    </div>
    <div class="section">
      <h2>Final Summary</h2>
      <p>${escapeHtml(input.finalSummary)}</p>
    </div>
    <div class="section">
      <h2>Safety Flags</h2>
      <ul>${safetyFlags}</ul>
    </div>
  </body>
</html>`;
  }
}