'use client';

import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PushToCrmButton } from '@/components/trace/PushToCrmButton';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

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

  // Fallback: if property address fields missing but mail fields found,
  // use mail fields as property fields (e.g. Bexar County records only have mailing address)
  const fallbacks: [OurField, OurField][] = [
    ['address', 'mail_address'],
    ['city', 'mail_city'],
    ['state', 'mail_state'],
  ];

  for (const [required, fallback] of fallbacks) {
    if (!usedFields.has(required) && usedFields.has(fallback)) {
      // Find the header that was mapped to the fallback field and remap it
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

    // Build owner name from parts if needed
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

type Phase = 'upload' | 'processing' | 'complete';

interface JobStats {
  job_id: string | null;
  total_records: number;
  dedupe_removed: number;
  records_submitted: number;
  cached_count: number;
  estimated_cost: number;
  message?: string;
}

interface CompleteStats {
  records_submitted: number;
  records_matched: number;
  total_charge: number;
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

  // Drag state
  const [dragActive, setDragActive] = useState(false);

  // ─── File Parsing ───────────────────────────────────────────────────

  const processFileData = useCallback((headers: string[], rows: Record<string, string>[], name: string) => {
    setFileName(name);
    setHeaders(headers);
    setPreviewRows(rows.slice(0, 5));
    setTotalRows(rows.length);

    const detected = detectMapping(headers);
    setMapping(detected);

    // Validate required columns
    const mappedFields = new Set(Object.values(detected));
    const errors: string[] = [];
    if (!mappedFields.has('address')) errors.push('Could not detect an "address" column');
    if (!mappedFields.has('city')) errors.push('Could not detect a "city" column');
    if (!mappedFields.has('state')) errors.push('Could not detect a "state" column');
    setMappingErrors(errors);

    if (errors.length === 0) {
      const mapped = mapRows(rows, detected);
      setAllRecords(mapped);
    } else {
      setAllRecords([]);
    }
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
          if (results.data.length > 10000) {
            setError('Maximum 10,000 records per upload');
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
          if (json.length > 10000) {
            setError('Maximum 10,000 records per upload');
            return;
          }

          const fileHeaders = Object.keys(json[0]);
          // Convert all values to strings
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

    try {
      const response = await fetch('/api/trace/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          records: allRecords,
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
        });
        setLoading(false);
        return;
      }

      setJobId(data.job_id);
      setPhase('processing');

      // Poll for results
      let attempts = 0;
      const maxAttempts = 120; // 10 minutes at 5s intervals

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

        // Completed or failed
        if (statusData.status === 'completed') {
          setCompleteStats({
            records_submitted: statusData.records_submitted,
            records_matched: statusData.records_matched,
            total_charge: statusData.total_charge,
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

      // Timed out
      setError('Processing is taking longer than expected. Check back later.');
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
                  <CardTitle>Detected Column Mapping</CardTitle>
                  <CardDescription>
                    {Object.keys(mapping).length} of {headers.length} columns mapped
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

                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {headers.map((header) => (
                      <div key={header} className="flex items-center gap-2 py-1">
                        <span className="text-gray-500 truncate flex-1">{header}</span>
                        {mapping[header] ? (
                          <>
                            <span className="text-gray-400">&rarr;</span>
                            <span className="font-medium text-green-700">{mapping[header]}</span>
                          </>
                        ) : (
                          <span className="text-gray-300 italic">ignored</span>
                        )}
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
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-gray-900">
                          {allRecords.length} valid records ready to submit
                        </p>
                        <p className="text-sm text-gray-500">
                          Estimated max cost: ${(allRecords.length * 0.07).toFixed(2)} ($0.07 per successful match)
                        </p>
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
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-sm text-gray-500">Estimated Max Cost</p>
                  <p className="text-2xl font-bold">${jobStats.estimated_cost.toFixed(2)}</p>
                </div>
              </div>
            )}

            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto" />
            <p className="text-gray-700 font-medium">Processing your upload...</p>
            {pollProgress ? (
              <p className="text-gray-500 text-sm">{pollProgress}</p>
            ) : (
              <p className="text-gray-500 text-sm">This may take several minutes for large uploads. Please keep this page open.</p>
            )}

            {error && (
              <p className="text-sm text-red-600 mt-4">{error}</p>
            )}
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
                    </>
                  )}
                </div>
              )}

              {jobStats?.message && (
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
