'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PushToCrmButton } from '@/components/trace/PushToCrmButton';
import { BulkSkipSummary } from '@/components/trace/BulkSkipSummary';
import { PRICING } from '@/lib/constants';
import { chargePerRecord, chargePerTrace } from '@/lib/suite/pricing';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

/**
 * THE CAP, REFUSED HERE RATHER THAN AFTER A SUBMIT THE USER WAITED ON.
 *
 * Same 500 the three submit routes hold (app/api/trace/bulk/route.ts, its v1
 * twin and lib/suite/mcp-tools.ts), kept as a local constant rather than
 * imported, for the reason app/api/trace/bulk/download/route.ts keeps its own:
 * importing a submit route would drag its whole vendor and billing graph into a
 * client bundle. A test pins the two together.
 *
 * IT IS CHECKED AGAINST THE ROW COUNT OF THE FILE, WHICH IS DELIBERATELY THE
 * STRICTER NUMBER.
 *
 * WHERE THE GAP ACTUALLY IS, corrected on 2026-09-18. An earlier version of this
 * comment said the route counts records after deduplication and used duplicates
 * as the example. That is wrong, and a wrong rationale is worse than none
 * because it is what the next person reads: app/api/trace/bulk/route.ts caps on
 * `records.length` at :65, BEFORE removeBatchDuplicates at :90, so duplicates
 * are not the gap at all.
 *
 * The real gap is INVALID rows. mapRows() below drops any row missing an
 * address, city or state before the page posts anything, so a 520-row county
 * export carrying 30 rows with no city is a legitimate 490-record job that this
 * refuses. mapRows only ever drops rows, never adds them, so the parsed count is
 * always at least the submitted count and this can never under-refuse.
 *
 * That is the safe direction and it is chosen, not overlooked: a false refusal
 * is instant, visible and fixed by splitting the file, while a false acceptance
 * means waiting through a submit to be told no, which is the exact failure this
 * check exists to remove. It also refuses on the number the user is looking at.
 * The preview above says "N records", and a refusal quoting a count they cannot
 * see would be worse than the strictness.
 */
const MAX_RECORDS = 500;

/**
 * What the user is told when the file is over the cap.
 *
 * IT MUST NOT TELL THEM THEIR JOB IS TOO BIG, because it might not be. Since the
 * check is on rows and the cap is on records, a customer whose 490-record job was
 * refused would otherwise read "you can send up to 500 records" and conclude the
 * product cannot take 490. So the sentence names the cap and says this FILE has
 * more rows than that, which is the fact we actually checked.
 */
const OVER_CAP_MESSAGE = `We can take up to ${MAX_RECORDS} records in one go, and this file has more rows than that. Split it into smaller files and send them one after another.`;

// ─── Column Mapping ─────────────────────────────────────────────────────────

type OurField = 'address' | 'city' | 'state' | 'zip' | 'first_name' | 'last_name' | 'owner_name' | 'mail_address' | 'mail_city' | 'mail_state';

const COLUMN_ALIASES: Record<OurField, string[]> = {
  address: ['address', 'property_address', 'address_line_1', 'street', 'street_address', 'site_address', 'situs_address', 'siteaddr', 'saddstr'],
  city: ['city', 'address_city', 'scity', 'property_city', 'site_city'],
  state: ['state', 'address_state', 'st', 'state2', 'property_state'],
  zip: ['zip', 'address_postal_code', 'mailing_zip_code', 'zip_code', 'zipcode', 'postal_code', 'szip', 'szip5'],
  first_name: ['first_name', '1st_owner_s_first_name', 'firstname', 'first', 'owner_first', 'ownfrst', 'owner_primary_first'],
  last_name: ['last_name', '1st_owner_s_last_name', 'lastname', 'last', 'owner_last', 'ownlast', 'owner_primary_last'],
  owner_name: ['owner_name', 'owner', 'reported_owner_name', 'true_owner_name', 'contact_name', 'assessed_owner', 'ownername', 'full_name'],
  mail_address: ['mail_address', 'mailing_address', 'owner_address', 'true_owner_address', 'mailadd'],
  mail_city: ['mail_city', 'mailing_city'],
  mail_state: ['mail_state', 'mailing_state', 'mail_state2'],
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().trim().replace(/['\s-]/g, '_');
}

function detectMapping(headers: string[]): Record<string, OurField> {
  const mapping: Record<string, OurField> = {};
  const usedFields = new Set<OurField>();

  for (const header of headers) {
    const normalized = normalizeHeader(header);

    for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [OurField, string[]][]) {
      if (usedFields.has(field)) continue;
      if (aliases.includes(normalized)) {
        mapping[header] = field;
        usedFields.add(field);
        break;
      }
    }
  }

  // Fallback: if property address fields missing but mail fields found
  const fallbacks: [OurField, OurField][] = [
    ['address', 'mail_address'],
    ['city', 'mail_city'],
    ['state', 'mail_state'],
  ];

  for (const [required, fallback] of fallbacks) {
    if (!usedFields.has(required) && usedFields.has(fallback)) {
      const header = Object.entries(mapping).find(([, f]) => f === fallback)?.[0];
      if (header) {
        mapping[header] = required;
        usedFields.add(required);
        usedFields.delete(fallback);
      }
    }
  }

  return mapping;
}

interface MappedRecord {
  address: string;
  city: string;
  state: string;
  zip: string;
  owner_name?: string;
  mailing_address?: string;
}

function mapRows(
  rows: Record<string, string>[],
  mapping: Record<string, OurField>
): MappedRecord[] {
  const results: MappedRecord[] = [];

  for (const row of rows) {
    const mapped: Record<string, string> = {};
    for (const [header, field] of Object.entries(mapping)) {
      mapped[field] = (row[header] || '').trim();
    }

    let ownerName = mapped.owner_name || '';
    if (!ownerName && (mapped.first_name || mapped.last_name)) {
      ownerName = [mapped.first_name, mapped.last_name].filter(Boolean).join(' ');
    }

    const address = mapped.address || '';
    const city = mapped.city || '';
    const state = mapped.state || '';

    if (!address || !city || !state) continue;

    results.push({
      address,
      city,
      state,
      zip: mapped.zip || '',
      owner_name: ownerName || undefined,
      mailing_address: mapped.mail_address || undefined,
    });
  }

  return results;
}

// ─── Template Download ──────────────────────────────────────────────────────

function downloadTemplate() {
  const csv = 'address,city,state,zip,first_name,last_name,mail_address,mail_city,mail_state\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'proptracer-bulk-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Page Component ─────────────────────────────────────────────────────────

/**
 * 'checkback' IS THE FIX FOR A DEAD END, not a new feature.
 *
 * The poll below runs 120 times at 5 s, about ten minutes. When it ran out it
 * set an error and stopped the spinner but never moved `phase`, so the page sat
 * on the processing card showing a spinner AND a red error, with no button and
 * no way out. The job carried on running server-side the whole time.
 *
 * David's decision, 2026-09-18: do not just raise the number. Hand the user the
 * job id and send them to the history page, which already lists bulk jobs with a
 * status badge and, once the job finishes, a results CSV and a Push to CRM
 * button. A cron settles the job whether or not this page is open, so the handoff
 * is honest rather than a shrug.
 */
type Phase = 'upload' | 'processing' | 'checkback' | 'complete';

interface JobStats {
  job_id: string | null;
  total_records: number;
  dedupe_removed: number;
  records_submitted: number;
  cached_count: number;
  estimated_cost: number;
  // Rows accepted but never traced, and the reason. Both come straight off the
  // submit response. At SUBMIT time these can only be rows nobody could be asked
  // about, because no vendor has run yet: the route sends
  // PROPERTY_TRACE_NO_KEY_REASON, which says the row was missing the street,
  // city or state, and that it was free. The finished job can carry more kinds,
  // and CompleteStats below is where they show up.
  records_skipped?: number;
  skipped_reason?: string;
  message?: string;
}

interface CompleteStats {
  records_submitted: number;
  records_matched: number;
  total_charge: number;
  // The same two facts read back off the FINISHED job rather than the submit,
  // because that is what the user is looking at when they ask why a row came
  // back empty. Null reason means there was nothing to explain.
  //
  // `records_skipped` IS NOT AN ALL-FREE COUNT ANY MORE. The status route builds
  // it from rowSkipReason(), which answers for both queues, and one of the five
  // answers belongs to a row that WAS charged: its property record was bought
  // and only the contact lookup failed. So nothing on this page may label this
  // number "not charged". The reason sentence carries the money fact, per row,
  // because it is the only thing that knows which billing model the row was on.
  records_skipped: number;
  skip_reason: string | null;
}

export default function BulkUploadPage() {
  const [phase, setPhase] = useState<Phase>('upload');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Upload phase
  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, OurField>>({});
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [allRawRows, setAllRawRows] = useState<Record<string, string>[]>([]);
  const [allRecords, setAllRecords] = useState<MappedRecord[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [mappingErrors, setMappingErrors] = useState<string[]>([]);

  // Processing phase
  const [jobStats, setJobStats] = useState<JobStats | null>(null);
  const [pollProgress, setPollProgress] = useState<string | null>(null);
  const abortRef = useRef(false);

  // Complete phase
  const [completeStats, setCompleteStats] = useState<CompleteStats | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  // BOTH RATES, BECAUSE ONE UPLOAD CAN CARRY BOTH BILLING MODELS. A row with an
  // owner of record is tier 1, charged per successful trace and free on a miss.
  // A row without one runs a Full Property Trace, which is tier 2 and charged
  // per record submitted. Quoting one rate over a mixed file understates or
  // overstates it and, worse, implies the wrong model for half the rows.
  //
  // Both default to the Pay-As-You-Go column, which is the dearer one, so a
  // profile that has not loaded yet can only ever over-quote.
  const [perTraceRate, setPerTraceRate] = useState<number>(PRICING.CHARGE_PER_SUCCESS_WALLET);
  const [perRecordRate, setPerRecordRate] = useState<number>(
    PRICING.TIER2_PER_RECORD_SUBMITTED_WALLET
  );

  useEffect(() => {
    const loadRate = async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase
          .from('user_profiles')
          .select('subscription_tier, is_acquisition_pro_member, gateway_products')
          .eq('id', user.id)
          .single();
        if (data) {
          setPerTraceRate(chargePerTrace(data));
          setPerRecordRate(chargePerRecord(data));
        }
      }
    };
    loadRate();
  }, []);

  // Re-validate and re-map when mapping changes
  useEffect(() => {
    if (headers.length === 0 || allRawRows.length === 0) return;
    const mappedFieldSet = new Set(Object.values(mapping));
    const errors: string[] = [];
    if (!mappedFieldSet.has('address')) errors.push('Could not detect an "address" column');
    if (!mappedFieldSet.has('city')) errors.push('Could not detect a "city" column');
    if (!mappedFieldSet.has('state')) errors.push('Could not detect a "state" column');
    setMappingErrors(errors);

    if (errors.length === 0) {
      setAllRecords(mapRows(allRawRows, mapping));
    } else {
      setAllRecords([]);
    }
  }, [mapping, headers, allRawRows]);

  // Handle manual column mapping change
  const handleMappingChange = useCallback((header: string, value: string) => {
    setMapping(prev => {
      const next = { ...prev };
      if (value === '') {
        delete next[header];
      } else {
        // Remove any other header mapped to this field (each field maps once)
        for (const [h, f] of Object.entries(next)) {
          if (f === value && h !== header) {
            delete next[h];
          }
        }
        next[header] = value as OurField;
      }
      return next;
    });
  }, []);

  // Drag state
  const [dragActive, setDragActive] = useState(false);

  // ─── File Parsing ───────────────────────────────────────────────────

  const processFileData = useCallback((headers: string[], rows: Record<string, string>[], name: string) => {
    setFileName(name);
    setHeaders(headers);
    setPreviewRows(rows.slice(0, 5));
    setAllRawRows(rows);
    setTotalRows(rows.length);

    // Auto-detect mapping; useEffect handles validation and row mapping
    const detected = detectMapping(headers);
    setMapping(detected);
  }, []);

  const handleFile = useCallback((file: File) => {
    setError(null);
    setMappingErrors([]);

    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'csv') {
      Papa.parse<Record<string, string>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (!results.meta.fields || results.meta.fields.length === 0) {
            setError('Could not parse CSV headers');
            return;
          }
          if (results.data.length === 0) {
            setError('CSV file is empty');
            return;
          }
          if (results.data.length > MAX_RECORDS) {
            setError(OVER_CAP_MESSAGE);
            return;
          }
          processFileData(results.meta.fields, results.data, file.name);
        },
        error: () => {
          setError('Failed to parse CSV file');
        },
      });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const json = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' });

          if (json.length === 0) {
            setError('Excel file is empty');
            return;
          }
          if (json.length > MAX_RECORDS) {
            setError(OVER_CAP_MESSAGE);
            return;
          }

          const fileHeaders = Object.keys(json[0]);
          const rows = json.map((row) => {
            const cleaned: Record<string, string> = {};
            for (const [k, v] of Object.entries(row)) {
              cleaned[k] = String(v ?? '');
            }
            return cleaned;
          });

          processFileData(fileHeaders, rows, file.name);
        } catch {
          setError('Failed to parse Excel file');
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      setError('Unsupported file type. Please upload .csv, .xlsx, or .xls');
    }
  }, [processFileData]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  // ─── Submit ─────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (allRecords.length === 0) return;

    setLoading(true);
    setError(null);
    abortRef.current = false;

    const recordsToSubmit = [...allRecords];

    setPhase('processing');

    try {
      const response = await fetch('/api/trace/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: recordsToSubmit,
          fileName: fileName || 'upload.csv',
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to submit bulk trace');
        setLoading(false);
        return;
      }

      setJobStats(data as JobStats);

      // If no records to process (all duplicates)
      if (!data.job_id) {
        setPhase('complete');
        setCompleteStats({
          records_submitted: 0,
          records_matched: 0,
          total_charge: 0,
          // Nothing reached a job, so the only skip facts that exist are the
          // ones the submit response just handed back.
          records_skipped: data.records_skipped || 0,
          skip_reason: data.skipped_reason || null,
        });
        setLoading(false);
        return;
      }

      setJobId(data.job_id);

      // Poll for results
      let attempts = 0;
      const maxAttempts = 120;

      while (attempts < maxAttempts && !abortRef.current) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        attempts++;

        const statusResponse = await fetch(
          `/api/trace/bulk/status?job_id=${data.job_id}`
        );
        const statusData = await statusResponse.json();

        if (!statusData.success) {
          setError(statusData.error || 'Failed to check job status');
          setLoading(false);
          return;
        }

        if (statusData.status === 'processing') {
          if (statusData.results_so_far && statusData.records_submitted) {
            setPollProgress(`${statusData.results_so_far} of ${statusData.records_submitted} records processed`);
          }
          continue;
        }

        if (statusData.status === 'completed') {
          setCompleteStats({
            records_submitted: statusData.records_submitted,
            records_matched: statusData.records_matched,
            total_charge: statusData.total_charge,
            // Fall back to what the SUBMIT response said rather than to zero.
            // `data` is used rather than the jobStats state because this closure
            // still holds the pre-setState value. A status response that has not
            // been taught to carry these would otherwise erase a skip the user
            // was already told about at submit time.
            records_skipped: statusData.records_skipped ?? data.records_skipped ?? 0,
            skip_reason: statusData.skip_reason ?? data.skipped_reason ?? null,
          });
          setPhase('complete');
          setLoading(false);
          return;
        }

        if (statusData.status === 'failed') {
          setError(statusData.error_message || 'Job failed');
          setLoading(false);
          return;
        }
      }

      // OUT OF POLLS, NOT OUT OF JOB. Nothing here stops the work: the rows are
      // on the queue and a cron settles them whether or not this page is open.
      // So this is a handoff, not an error, and it must not be rendered as one.
      // Moving `phase` is the whole fix for the old dead end, where the page
      // kept a spinner and a red error on screen with no way forward.
      setPhase('checkback');
      setLoading(false);
    } catch {
      setError('Failed to connect to server');
      setLoading(false);
    }
  };

  // ─── Reset ──────────────────────────────────────────────────────────

  const handleReset = () => {
    abortRef.current = true;
    setPhase('upload');
    setError(null);
    setLoading(false);
    setFileName(null);
    setHeaders([]);
    setMapping({});
    setPreviewRows([]);
    setAllRawRows([]);
    setAllRecords([]);
    setTotalRows(0);
    setMappingErrors([]);
    setJobStats(null);
    setPollProgress(null);
    setCompleteStats(null);
    setJobId(null);
  };

  // ─── Render ─────────────────────────────────────────────────────────

  const mappedFields = Object.values(mapping);

  /**
   * Rows with no owner of record, which is to say the TIER 2 rows.
   *
   * WHAT THIS COUNT MEANS CHANGED COMPLETELY IN PHASE 5c, TWICE. It began as the
   * count for the AI Research toggle, which went and found those owners on the
   * open web; that engine was removed on 2026-09-17 and the rows were skipped
   * and free. As of 5c-3A they are traced automatically: a Full Property Trace
   * looks up the county record to find the owner, then goes after their contacts,
   * and it is charged per RECORD SUBMITTED rather than per successful trace.
   *
   * So this is no longer the count of rows we will not do. It is the count of
   * rows on the other billing model, and it is still shown before the upload for
   * the same reason it always was: a customer should learn what a third of their
   * file is going to cost them before they commit to it, not after.
   */
  const blankOwnerCount = allRecords.filter(
    (record) => !(record.owner_name || '').trim()
  ).length;
  /** Rows that arrived with an owner of record. Tier 1, charged only on a hit. */
  const ownedCount = allRecords.length - blankOwnerCount;

  /**
   * The most this upload can cost, with each half priced on its own model.
   *
   * Tier 1 is a genuine ceiling: those rows are free unless we find contacts.
   * Tier 2 is simply the price, owed on every record sent. Adding them gives an
   * upper bound that is honest for the file as a whole, and the sentences beside
   * it say which half is which rather than letting one word cover both.
   */
  const maxCost = ownedCount * perTraceRate + blankOwnerCount * perRecordRate;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Bulk Upload</h1>
        <p className="text-gray-500">Upload a CSV or Excel file to trace multiple properties at once</p>
      </div>

      {/* Upload Phase */}
      {phase === 'upload' && (
        <div className="space-y-6">
          {/* Template + Upload */}
          <Card>
            <CardHeader>
              <CardTitle>Upload File</CardTitle>
              <CardDescription>
                Upload a .csv, .xlsx, or .xls file. We auto-detect columns from CoStar, Reonomy, county records, and other CRE tools.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button variant="outline" onClick={downloadTemplate}>
                Download Template CSV
              </Button>

              {/* Drop zone */}
              <div
                className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                  dragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
                }`}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                onClick={() => document.getElementById('file-input')?.click()}
              >
                <input
                  id="file-input"
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleFileInput}
                  className="hidden"
                />
                {fileName ? (
                  <p className="text-gray-700 font-medium">{fileName}</p>
                ) : (
                  <>
                    <p className="text-gray-600 font-medium">Drag and drop your file here</p>
                    <p className="text-gray-400 text-sm mt-1">or click to browse (.csv, .xlsx, .xls)</p>
                  </>
                )}
              </div>

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}
            </CardContent>
          </Card>

          {/* Mapping + Preview */}
          {headers.length > 0 && (
            <>
              {/* Detected Mapping */}
              <Card>
                <CardHeader>
                  <CardTitle>Column Mapping</CardTitle>
                  <CardDescription>
                    {Object.keys(mapping).length} of {headers.length} columns mapped. Use the dropdowns to adjust mappings.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {mappingErrors.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-md p-3 mb-4">
                      <p className="text-sm font-medium text-red-800">Missing required columns:</p>
                      <ul className="text-sm text-red-700 mt-1 list-disc list-inside">
                        {mappingErrors.map((err, i) => (
                          <li key={i}>{err}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    {headers.map((header) => (
                      <div key={header} className="flex items-center gap-2 py-1">
                        <span className="text-gray-500 truncate flex-1">{header}</span>
                        <span className="text-gray-400">&rarr;</span>
                        <select
                          value={mapping[header] || ''}
                          onChange={(e) => handleMappingChange(header, e.target.value)}
                          className="text-sm border border-gray-300 rounded px-2 py-1 bg-white min-w-[140px]"
                        >
                          <option value="">ignored</option>
                          {(Object.keys(COLUMN_ALIASES) as OurField[]).map((field) => (
                            <option
                              key={field}
                              value={field}
                              disabled={Object.values(mapping).includes(field) && mapping[header] !== field}
                            >
                              {field}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Preview Table */}
              <Card>
                <CardHeader>
                  <CardTitle>Preview ({totalRows} records)</CardTitle>
                  <CardDescription>
                    Showing first {Math.min(5, previewRows.length)} rows mapped to our fields
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          {mappedFields.filter((f, i, a) => a.indexOf(f) === i).map((field) => (
                            <th key={field} className="text-left py-2 px-3 font-medium text-gray-700">
                              {field}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.map((row, rowIdx) => {
                          const uniqueFields = mappedFields.filter((f, i, a) => a.indexOf(f) === i);
                          return (
                            <tr key={rowIdx} className="border-b">
                              {uniqueFields.map((field) => {
                                const header = Object.entries(mapping).find(([, f]) => f === field)?.[0];
                                return (
                                  <td key={field} className="py-2 px-3 text-gray-600 truncate max-w-[200px]">
                                    {header ? row[header] || '' : ''}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Submit */}
              {mappingErrors.length === 0 && allRecords.length > 0 && (
                <Card>
                  <CardContent className="pt-6 space-y-4">
                    {blankOwnerCount > 0 && (
                      <div
                        data-testid="blank-owner-warning"
                        className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
                      >
                        <p className="font-medium">
                          {blankOwnerCount} of these records have no owner name.
                        </p>
                        <p className="mt-1">
                          We run a full property trace on those. We look up the county record to
                          find the owner, then go after their phone numbers and emails, so you do
                          not need to add the owner yourself. Those rows are charged for every
                          record you send, which means they cost the same whether or not we come
                          back with contacts.
                        </p>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <div>
                        {/* ONE COUNT, BECAUSE EVERY ROW IS NOW TRACED. This used
                            to switch to a "N of M will be traced" form whenever
                            rows were being skipped, so that "100 valid records
                            ready to submit" could not sit above a banner saying
                            40 of them were dropped: two numbers, one upload,
                            disagreeing. Nothing is dropped any more, so the two
                            numbers are equal and the conditional was dead. The
                            intent survives, and it is why the banner above
                            describes the blank-owner rows as a SUBSET on a
                            different billing model rather than quoting a rival
                            total. */}
                        <p className="font-medium text-gray-900">
                          {allRecords.length} records ready to submit
                        </p>
                        <p className="text-sm text-gray-500">
                          Most this can cost: ${maxCost.toFixed(2)}
                        </p>
                        {/* THE MODEL, NOT JUST THE MONEY. Each sentence covers
                            one half of the file and says how that half is
                            billed. The old single line quoted a per-match rate
                            over the whole upload, which is the tier 1 model and
                            is false of every blank-owner row, and one line
                            covering both would be wrong for somebody whichever
                            model it named. Only the halves that exist are shown,
                            so a single-model upload reads as one plain
                            sentence. */}
                        {ownedCount > 0 && (
                          <p className="text-sm text-gray-500">
                            The {ownedCount} records with an owner name are $
                            {perTraceRate.toFixed(2)} each, and you are only charged when we find
                            contacts.
                          </p>
                        )}
                        {blankOwnerCount > 0 && (
                          <p className="text-sm text-gray-500">
                            The {blankOwnerCount} with no owner name are ${perRecordRate.toFixed(2)}{' '}
                            each, charged for every one you send.
                          </p>
                        )}
                      </div>
                      <div className="flex gap-3">
                        <Button variant="outline" onClick={handleReset}>
                          Cancel
                        </Button>
                        <Button onClick={handleSubmit} disabled={loading}>
                          {loading ? 'Submitting...' : 'Submit for Tracing'}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {/* Processing Phase */}
      {phase === 'processing' && (
        <Card>
          <CardContent className="py-12 text-center space-y-4">
            {jobStats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8 text-left">
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-sm text-gray-500">Total Uploaded</p>
                  <p className="text-2xl font-bold">{jobStats.total_records}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-sm text-gray-500">Duplicates Removed</p>
                  <p className="text-2xl font-bold">{jobStats.dedupe_removed}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-sm text-gray-500">Submitted for Tracing</p>
                  <p className="text-2xl font-bold">{jobStats.records_submitted}</p>
                </div>
                {/* RELABELLED FROM THE OLD ESTIMATED-MAX WORDING. The route
                    builds this number from both rates, and for an upload that is
                    entirely blank-owner rows it is not an estimate at all, it is
                    the price. This label is true under either model: a ceiling
                    for tier 1, and exactly right for tier 2. */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-sm text-gray-500">Most This Can Cost</p>
                  <p className="text-2xl font-bold">${jobStats.estimated_cost.toFixed(2)}</p>
                </div>
                {/* TWO THINGS THIS LABEL MUST NOT DO, AND IT TOOK TWO GOES.
                    It may not promise the rows were free, which the original
                    label did by pairing "Skipped" with a not-charged claim,
                    because the count can include a full property trace whose
                    record was bought before the contact vendor failed. And it
                    may not name a category wider
                    than the number under it, which its first replacement did:
                    `records_skipped` holds only rows with a STATED REASON, so a
                    label naming every empty row, showing 12 beside "Records
                    Matched 40" on a 100-record job, told the customer 88 records
                    got contacts when 60 did not. It names the subset it actually
                    holds. */}
                {(jobStats.records_skipped || 0) > 0 && (
                  <div className="bg-amber-50 rounded-lg p-4">
                    <p className="text-sm text-gray-500">Records We Can Explain</p>
                    <p className="text-2xl font-bold text-amber-800">{jobStats.records_skipped}</p>
                  </div>
                )}
              </div>
            )}

            {/* The user is told at submit time, not only at the end. The same
                component renders it in the finished summary below. */}
            <div className="text-left">
              <BulkSkipSummary
                recordsSkipped={jobStats?.records_skipped}
                skipReason={jobStats?.skipped_reason}
              />
            </div>

            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto" />
            <p className="text-gray-700 font-medium">Processing your upload...</p>
            {pollProgress ? (
              <p className="text-gray-500 text-sm">{pollProgress}</p>
            ) : (
              // IT NO LONGER ASKS THEM TO KEEP THE PAGE OPEN, because that was
              // never true and is now the opposite of the advice one card over.
              // The rows are on a queue a cron works, so closing this tab costs
              // the customer nothing.
              <p className="text-gray-500 text-sm">
                This can take a few minutes on a big upload. You can leave this page if you want,
                the work carries on without it and the results show up in your history.
              </p>
            )}

            {error && (
              <p className="text-sm text-red-600 mt-4">{error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Check-back Phase */}
      {phase === 'checkback' && (
        <Card>
          <CardHeader>
            <CardTitle>This one is taking a while</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-gray-700">
              Your upload is still running and we have stopped watching it from this page. Nothing
              has gone wrong and nothing has stopped. The work carries on in the background whether
              or not this page is open, so you can close it.
            </p>
            <p className="text-gray-700">
              Open your history to see where the job has got to. Once it finishes you can download
              the results there or push them straight to your CRM.
            </p>
            {/* The job id, because the history page lists jobs by file name and
                time and a user with two uploads of the same file needs to be
                able to tell them apart. */}
            {jobId && (
              <p className="text-sm text-gray-500">
                Job reference <span className="font-mono">{jobId}</span>
              </p>
            )}
            <div className="flex gap-3">
              <Button onClick={() => { window.location.href = '/history'; }}>
                Go to History
              </Button>
              <Button variant="outline" onClick={handleReset}>
                Start New Upload
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Complete Phase */}
      {phase === 'complete' && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Upload Complete</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {jobStats && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-gray-50 rounded-lg p-4">
                    <p className="text-sm text-gray-500">Total Uploaded</p>
                    <p className="text-2xl font-bold">{jobStats.total_records}</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <p className="text-sm text-gray-500">Duplicates Removed</p>
                    <p className="text-2xl font-bold">{jobStats.dedupe_removed}</p>
                  </div>
                  {completeStats && (
                    <>
                      <div className="bg-green-50 rounded-lg p-4">
                        <p className="text-sm text-gray-500">Records Matched</p>
                        <p className="text-2xl font-bold text-green-700">{completeStats.records_matched}</p>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-4">
                        <p className="text-sm text-gray-500">Total Charged</p>
                        <p className="text-2xl font-bold">${completeStats.total_charge.toFixed(2)}</p>
                      </div>
                      {/* Same label as the processing tile, and for the same two
                          reasons: this count can include a billed row whose
                          contact lookup never completed, and it is only the rows
                          carrying a stated reason rather than every row that
                          came back empty. It sits directly beside Records
                          Matched, which is where a wider noun would have been
                          read as the whole story. */}
                      {completeStats.records_skipped > 0 && (
                        <div className="bg-amber-50 rounded-lg p-4">
                          <p className="text-sm text-gray-500">Records We Can Explain</p>
                          <p className="text-2xl font-bold text-amber-800">
                            {completeStats.records_skipped}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Why those rows came back empty, on screen, next to the counts.
                  Until this was here the only place that said it was the results
                  CSV, so a user had to download a file to find out that a row was
                  never traced and never charged rather than looked up and missed.
                  The sentence comes from the status route, which derives it from
                  skipReasonFor(), so it reads the same here, in the API, in the
                  MCP payload and in the CSV. The component decides whether there
                  is anything to show, so there is no second condition here that
                  can drift away from it. */}
              <BulkSkipSummary
                recordsSkipped={completeStats?.records_skipped}
                skipReason={completeStats?.skip_reason}
              />

              {/* The route's own message, which today only ever talks about
                  skipped rows. Shown only when the block above did not already
                  say it, so the same fact is never on screen twice. */}
              {!completeStats?.records_skipped && jobStats?.message && (
                <p className="text-sm text-gray-600">{jobStats.message}</p>
              )}

              <div className="flex gap-3">
                {jobId && (
                  <>
                    <Button
                      onClick={() => {
                        window.location.href = `/api/trace/bulk/download?job_id=${jobId}`;
                      }}
                    >
                      Download Results CSV
                    </Button>
                    <PushToCrmButton
                      jobId={jobId}
                      variant="outline"
                      size="default"
                      label="Add All to CRM"
                    />
                  </>
                )}
                <Button variant="outline" onClick={handleReset}>
                  Start New Upload
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
