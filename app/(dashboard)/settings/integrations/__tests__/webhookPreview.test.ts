import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(join(process.cwd(), 'app/(dashboard)/settings/integrations/page.tsx'), 'utf8')

describe('the Settings > Integrations webhook preview matches what trace.completed sends (spec D31)', () => {
  it('shows the three Tier 1 keys every trace now carries', () => {
    // MUTATION: delete the `"found_by": null,` line from WEBHOOK_PAYLOAD_EXAMPLE and this goes red.
    for (const s of ['"found_by": null', '"outcome_code": null', '"skip_reason": null']) {
      expect(PAGE, s).toContain(s)
    }
  })

  it('says every trace sends the same keys, and that nothing is sent when the system is busy', () => {
    expect(PAGE).toContain('Every trace sends the same keys')
    expect(PAGE).toContain('or the system is busy')
    expect(PAGE).not.toContain('sends the same event without')
    expect(PAGE).not.toContain('The last three fields come with')
  })
})
